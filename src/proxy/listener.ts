import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import { RequestContext } from './context.js';
import {
  configureServerKeepAlive,
  shouldSendConnectionClose,
  shouldKeepAlive,
} from './keepalive.js';

export interface HttpListenerConfig {
  host?: string;
  port?: number;
}

export interface HttpsListenerConfig {
  host?: string;
  port?: number;
  keyPath?: string;
  certPath?: string;
  certificates?: TlsCertificateConfig[];
  refuseUnknownSni?: boolean;
  clientAuth?: ClientCertAuthMode;
  clientCaPath?: string;
  clientCa?: string | Buffer;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
  watch?: boolean;
}

import { Clock } from '../util/clock.js';
import { formatHttpDate } from '../cache/http-date.js';
import { CertificateManager } from '../tls/cert-config.js';
import type { CertificateFileWatcher } from '../tls/cert-watcher.js';
import { DEFAULT_MIN_TLS_VERSION, DEFAULT_CIPHERS } from '../tls/constants.js';
import type { TlsCertificateConfig, ClientCertAuthMode } from '../tls/types.js';

export interface ListenerConfig {
  listeners: {
    http?: HttpListenerConfig;
    https?: HttpsListenerConfig;
  };
  shutdownGracePeriodMs?: number; // default 10,000 ms (10s)
  handleSignals?: boolean; // attach SIGINT/SIGTERM handlers (default: true)
  timeouts?: {
    clientHeadersMs?: number;
    clientRequestMs?: number;
    keepAliveTimeoutMs?: number;
  };
  server?: {
    maxRequestsPerSocket?: number;
    maxConnections?: number;
  };
  clock?: Clock;
}

export type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void | Promise<void>;

export class ProxyListener {
  private config: ListenerConfig;
  private requestHandler: RequestHandler;
  private httpServer?: http.Server;
  private httpsServer?: https.Server;
  private inFlightRequests: Set<http.ServerResponse> = new Set();
  private activeContexts: Set<RequestContext> = new Set();
  private sockets: Set<net.Socket> = new Set();
  private isStopping: boolean = false;
  private sigintListener?: () => void;
  private sigtermListener?: () => void;
  public flightMap?: Map<string, any>;
  public passMarkerMap?: Map<string, any>;
  public backgroundJobs?: Set<string>;
  public certificateManager?: CertificateManager;
  private certWatcher?: CertificateFileWatcher;
  private clientCaBuf?: Buffer;

  constructor(config: ListenerConfig, requestHandler: RequestHandler) {
    this.config = config;
    this.requestHandler = requestHandler;
  }

  public registerContext(context: RequestContext): () => void {
    this.activeContexts.add(context);
    return () => {
      this.activeContexts.delete(context);
    };
  }

  get httpPort(): number | undefined {
    if (!this.httpServer) return undefined;
    const addr = this.httpServer.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return undefined;
  }

  get httpsPort(): number | undefined {
    if (!this.httpsServer) return undefined;
    const addr = this.httpsServer.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return undefined;
  }

  get inFlightCount(): number {
    return this.inFlightRequests.size;
  }

  get shuttingDown(): boolean {
    return this.isStopping;
  }

  private trackRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const socket = req.socket;
    let reqCount = 1;
    if (socket) {
      (socket as any).__requestCount = ((socket as any).__requestCount || 0) + 1;
      reqCount = (socket as any).__requestCount;

      if (typeof (socket as any).getPeerCertificate === 'function') {
        const peerCert = (socket as any).getPeerCertificate(true);
        if (peerCert && Object.keys(peerCert).length > 0) {
          (req as any).clientCert = {
            authorized: Boolean((socket as any).authorized),
            authorizationError: (socket as any).authorizationError,
            subject: peerCert.subject,
            issuer: peerCert.issuer,
            subjectaltname: peerCert.subjectaltname,
            san: peerCert.subjectaltname,
            fingerprint256: peerCert.fingerprint256,
            serialNumber: peerCert.serialNumber,
            validFrom: peerCert.valid_from,
            validTo: peerCert.valid_to,
            raw: peerCert.raw,
          };
        }
      }
    }

    const maxReqs = this.config.server?.maxRequestsPerSocket ?? 1000;
    const sendClose = shouldSendConnectionClose(req, {
      isShuttingDown: this.isStopping,
      requestsOnSocket: reqCount,
      maxRequestsPerSocket: maxReqs,
    });

    if (sendClose) {
      res.setHeader('Connection', 'close');
    } else if (req.httpVersion === '1.0' && shouldKeepAlive(req)) {
      res.setHeader('Connection', 'keep-alive');
    }

    this.inFlightRequests.add(res);

    const cleanup = () => {
      this.inFlightRequests.delete(res);
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
    });
  }

  public async start(): Promise<void> {
    const httpConf = this.config.listeners.http ?? {
      host: '0.0.0.0',
      port: 8080,
    };
    const httpHost = httpConf.host ?? '0.0.0.0';
    const httpPort = httpConf.port ?? 8080;

    // Setup HTTP server
    this.httpServer = http.createServer((req, res) => {
      this.trackRequest(req, res);
      this.requestHandler(req, res);
    });

    configureServerKeepAlive(this.httpServer, {
      maxConnections: this.config.server?.maxConnections ?? 10000,
      maxRequestsPerSocket: this.config.server?.maxRequestsPerSocket ?? 1000,
      keepAliveTimeoutMs: this.config.timeouts?.keepAliveTimeoutMs ?? 5000,
    });

    if (this.config.timeouts) {
      if (this.config.timeouts.clientHeadersMs !== undefined) {
        this.httpServer.headersTimeout = this.config.timeouts.clientHeadersMs;
      }
      if (this.config.timeouts.clientRequestMs !== undefined) {
        this.httpServer.requestTimeout = this.config.timeouts.clientRequestMs;
      }
      if (this.config.timeouts.keepAliveTimeoutMs !== undefined) {
        this.httpServer.keepAliveTimeout = this.config.timeouts.keepAliveTimeoutMs;
      }
    }

    const handleClientError = (err: any, socket: net.Socket) => {
      if (socket.writable && !socket.destroyed) {
        const rawPacketStr = err?.rawPacket ? err.rawPacket.toString('utf-8') : '';
        const isInvalidMethod =
          err?.code === 'HPE_INVALID_METHOD' &&
          /^[a-zA-Z0-9_-]+\s+\S+/i.test(rawPacketStr);

        const statusCode = isInvalidMethod ? 501 : 400;
        const statusText = isInvalidMethod ? 'Not Implemented' : 'Bad Request';
        const errorCode = isInvalidMethod ? 'NOT_IMPLEMENTED' : 'BAD_REQUEST';
        const message = isInvalidMethod
          ? 'HTTP method is not implemented or invalid'
          : 'Client request parse error';

        const body = JSON.stringify({
          error: {
            code: errorCode,
            message,
            requestId: 'client-error',
          },
        });
        const nowMs = this.config.clock ? this.config.clock.now() : Date.now();
        const response =
          `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
          `Content-Type: application/json\r\n` +
          `Cache-Control: no-store\r\n` +
          `Date: ${formatHttpDate(nowMs)}\r\n` +
          `Connection: close\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `\r\n` +
          body;
        socket.end(response);
      } else {
        socket.destroy(err);
      }
    };

    const handleConnect = (_req: http.IncomingMessage, socket: net.Socket) => {
      const allowHeader = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
      const body = JSON.stringify({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'CONNECT method is not allowed on reverse proxy',
          requestId: 'connect-denied',
        },
      });
      const response =
        `HTTP/1.1 405 Method Not Allowed\r\n` +
        `Content-Type: application/json\r\n` +
        `Cache-Control: no-store\r\n` +
        `Allow: ${allowHeader}\r\n` +
        `Connection: close\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `\r\n` +
        body;
      socket.end(response);
    };

    this.httpServer.on('connection', (socket) => {
      this.trackSocket(socket);
    });

    this.httpServer.on('clientError', handleClientError);
    this.httpServer.on('connect', handleConnect);

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(httpPort, httpHost, () => {
        this.httpServer!.removeListener('error', reject);
        resolve();
      });
    });

    // Setup optional HTTPS server
    if (this.config.listeners.https) {
      const httpsConf = this.config.listeners.https;

      if (httpsConf.keyPath) {
        try {
          fs.readFileSync(httpsConf.keyPath);
        } catch (err: any) {
          throw new Error(
            `Failed to read HTTPS key file at "${httpsConf.keyPath}": ${err.message}`
          );
        }
      }
      if (httpsConf.certPath) {
        try {
          fs.readFileSync(httpsConf.certPath);
        } catch (err: any) {
          throw new Error(
            `Failed to read HTTPS certificate file at "${httpsConf.certPath}": ${err.message}`
          );
        }
      }

      const certConfigs: TlsCertificateConfig[] = [];
      if (httpsConf.certificates && httpsConf.certificates.length > 0) {
        certConfigs.push(...httpsConf.certificates);
      } else if (httpsConf.certPath && httpsConf.keyPath) {
        certConfigs.push({
          certPath: httpsConf.certPath,
          keyPath: httpsConf.keyPath,
          isDefault: true,
        });
      }

      let clientCaBuf: Buffer | undefined;
      if (httpsConf.clientCaPath) {
        try {
          clientCaBuf = fs.readFileSync(httpsConf.clientCaPath);
        } catch (err: any) {
          throw new Error(
            `Failed to read client CA file at "${httpsConf.clientCaPath}": ${err.message}`
          );
        }
      } else if (httpsConf.clientCa) {
        clientCaBuf = Buffer.isBuffer(httpsConf.clientCa)
          ? httpsConf.clientCa
          : Buffer.from(httpsConf.clientCa);
      }

      this.clientCaBuf = clientCaBuf;

      this.certificateManager = new CertificateManager(certConfigs, {
        refuseUnknownSni: httpsConf.refuseUnknownSni,
        minVersion: httpsConf.minVersion ?? DEFAULT_MIN_TLS_VERSION,
        ciphers: httpsConf.ciphers ?? DEFAULT_CIPHERS,
        clientCa: clientCaBuf,
      });

      const defaultCert = this.certificateManager.getDefaultCertificate();
      if (!defaultCert) {
        throw new Error('No valid TLS certificate loaded for HTTPS listener');
      }

      const requestCert =
        httpsConf.clientAuth === 'optional' || httpsConf.clientAuth === 'required';
      const rejectUnauthorized = httpsConf.clientAuth === 'required';

      const httpsOptions: https.ServerOptions = {
        cert: defaultCert.cert,
        key: defaultCert.key,
        ca: clientCaBuf ?? defaultCert.ca,
        SNICallback: this.certificateManager.sniCallback,
        minVersion: httpsConf.minVersion ?? DEFAULT_MIN_TLS_VERSION,
        ciphers: httpsConf.ciphers ?? DEFAULT_CIPHERS,
        requestCert,
        rejectUnauthorized,
      };

      const httpsHost = httpsConf.host ?? '0.0.0.0';
      const httpsPort = httpsConf.port ?? 8443;

      this.httpsServer = https.createServer(httpsOptions, (req, res) => {
        this.trackRequest(req, res);
        this.requestHandler(req, res);
      });

      configureServerKeepAlive(this.httpsServer, {
        maxConnections: this.config.server?.maxConnections ?? 10000,
        maxRequestsPerSocket: this.config.server?.maxRequestsPerSocket ?? 1000,
        keepAliveTimeoutMs: this.config.timeouts?.keepAliveTimeoutMs ?? 5000,
      });

      this.httpsServer.on('connection', (socket) => {
        this.trackSocket(socket as net.Socket);
      });

      this.httpsServer.on('clientError', handleClientError);
      this.httpsServer.on('tlsClientError', (err: any, socket: net.Socket) => {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          this.httpsServer!.once('error', reject);
          this.httpsServer!.listen(httpsPort, httpsHost, () => {
            this.httpsServer!.removeListener('error', reject);
            resolve();
          });
        });
      } catch (err) {
        // If HTTPS fails to start, ensure HTTP server is cleaned up
        await this.stop();
        throw err;
      }
      // Start certificate watcher if configured (default: true)
      if (httpsConf.watch !== false) {
        this.certWatcher = this.certificateManager.watch({
          onError: (err) => {
            console.error(`[cert-rotation] Failed to reload certificate on disk: ${err.message}`);
          },
          onReload: () => {
            this.applyServerSecureContext();
          },
        });
      }
    }

    // Attach signal listeners if requested (default true)
    if (this.config.handleSignals !== false) {
      this.sigintListener = () => {
        void this.stop();
      };
      this.sigtermListener = () => {
        void this.stop();
      };
      process.once('SIGINT', this.sigintListener);
      process.once('SIGTERM', this.sigtermListener);
    }
  }

  public async close(): Promise<void> {
    return this.stop();
  }

  public async stop(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;

    // Clean up certificate watchers and managers
    if (this.certWatcher) {
      this.certWatcher.close();
      this.certWatcher = undefined;
    }
    if (this.certificateManager) {
      this.certificateManager.close();
      this.certificateManager = undefined;
    }

    // Remove signal listeners
    if (this.sigintListener) {
      process.removeListener('SIGINT', this.sigintListener);
      this.sigintListener = undefined;
    }
    if (this.sigtermListener) {
      process.removeListener('SIGTERM', this.sigtermListener);
      this.sigtermListener = undefined;
    }

    const graceMs = this.config.shutdownGracePeriodMs ?? 10000;

    // Close servers to stop accepting new connections
    const closeServer = (server?: http.Server | https.Server): Promise<void> => {
      if (!server) return Promise.resolve();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    };

    const serverClosePromises = Promise.all([
      closeServer(this.httpServer),
      closeServer(this.httpsServer),
    ]);

    // Close idle keep-alive connections immediately
    if (typeof (this.httpServer as any)?.closeIdleConnections === 'function') {
      (this.httpServer as any).closeIdleConnections();
    }
    if (typeof (this.httpsServer as any)?.closeIdleConnections === 'function') {
      (this.httpsServer as any).closeIdleConnections();
    }

    // Mark in-flight responses completing during drain with Connection: close
    for (const res of this.inFlightRequests) {
      if (!res.headersSent) {
        try {
          res.setHeader('Connection', 'close');
        } catch {
          // ignore
        }
      }
    }

    // Wait for in-flight requests and active contexts to drain or grace period to expire
    const drainPromise = new Promise<void>((resolve) => {
      if (this.inFlightRequests.size === 0 && this.activeContexts.size === 0) {
        resolve();
        return;
      }

      const checkInterval = setInterval(() => {
        if (this.inFlightRequests.size === 0 && this.activeContexts.size === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 20);

      // Force stop checking if timeout hits
      const timer = setTimeout(() => {
        clearInterval(checkInterval);
        for (const ctx of this.activeContexts) {
          ctx.abort('server_shutdown_past_grace_period');
        }
        this.activeContexts.clear();
        resolve();
      }, graceMs);

      // Don't keep event loop alive for this timer
      if (timer.unref) timer.unref();
    });

    await drainPromise;

    for (const ctx of this.activeContexts) {
      ctx.abort('server_shutdown_past_grace_period');
    }
    this.activeContexts.clear();

    // Destroy any remaining sockets
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();

    await serverClosePromises;
  }

  public applyServerSecureContext(): void {
    if (this.httpsServer && this.certificateManager) {
      const def = this.certificateManager.getDefaultCertificate();
      if (def) {
        try {
          (this.httpsServer as any).setSecureContext({
            cert: def.cert,
            key: def.key,
            ca: this.clientCaBuf ?? def.ca,
            minVersion: this.config.listeners.https?.minVersion ?? DEFAULT_MIN_TLS_VERSION,
            ciphers: this.config.listeners.https?.ciphers ?? DEFAULT_CIPHERS,
          });
        } catch (err: any) {
          console.error(`[cert-rotation] Failed to set secure context on server: ${err.message}`);
        }
      }
    }
  }

  public reloadCertificates(): void {
    if (this.certificateManager) {
      this.certificateManager.reloadAll();
      this.applyServerSecureContext();
    }
  }
}

export function startListener(
  config: ListenerConfig,
  handler: RequestHandler
): Promise<ProxyListener> {
  const listener = new ProxyListener(config, handler);
  return listener.start().then(() => listener);
}
