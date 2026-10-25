import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';
import net from 'node:net';
import { CertificateFileWatcher } from '../tls/cert-watcher.js';
import { loadAndValidateCertificate } from '../tls/cert-config.js';

export interface UpstreamConfig {
  keepAlive?: boolean; // default true
  maxSockets?: number; // default 256
  maxFreeSockets?: number; // default 32
  keepAliveMsecs?: number; // default 1000
  ca?: string | Buffer | Array<string | Buffer>; // for test CA injection
  caPath?: string;
  rejectUnauthorized?: boolean; // default true
  clientCert?: string | Buffer;
  clientKey?: string | Buffer;
  clientCertPath?: string;
  clientKeyPath?: string;
  watchCerts?: boolean;
  onCertRotate?: () => void;
  onCertError?: (err: Error) => void;
}

import { isIdempotent, isSafe } from './methods.js';

/**
 * Pure function: decides whether to retry a failed upstream request on a fresh connection.
 * Only retries if:
 * 1. Error is ECONNRESET / EPIPE / socket hang up
 * 2. Method is safe and idempotent (GET, HEAD, OPTIONS)
 * 3. The request was dispatched on a REUSED keep-alive socket
 * 4. No request body has been started / written
 */
export function shouldRetryOnStaleSocket(
  err: any,
  method: string,
  reusedSocket: boolean,
  bodyStarted: boolean
): boolean {
  if (!reusedSocket) return false;
  if (bodyStarted) return false;

  const upperMethod = (method ?? '').toUpperCase();
  if (!isIdempotent(upperMethod) || !isSafe(upperMethod)) return false;

  if (!err) return false;
  const code = err.code;
  const msg = typeof err.message === 'string' ? err.message : '';

  const isStaleError =
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    /socket hang up|ECONNRESET|EPIPE/i.test(msg);

  return isStaleError;
}

export interface UpstreamRequestOptions {
  method: string;
  url: URL;
  headers: http.OutgoingHttpHeaders;
  bodyStream?: NodeJS.ReadableStream;
  signal?: AbortSignal;
  onInformation?: (info: http.InformationEvent) => void;
  rejectUnauthorized?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  servername?: string;
  originId?: string;
  maxSockets?: number;
  lookup?: (hostname: string, options: any, callback: (err: any, address?: any, family?: any) => void) => void;
}

export class UpstreamClient {
  public readonly httpAgent: http.Agent;
  public httpsAgent: https.Agent;
  public readonly config: UpstreamConfig;
  private readonly agentCache: Map<string, http.Agent | https.Agent> = new Map();
  private readonly originAgents: Map<string, Set<http.Agent | https.Agent>> = new Map();
  private certWatcher?: CertificateFileWatcher;

  constructor(config: UpstreamConfig = {}) {
    this.config = { ...config };

    if (!this.config.clientCert && this.config.clientCertPath) {
      try {
        this.config.clientCert = fs.readFileSync(this.config.clientCertPath);
      } catch (err: any) {
        console.error(`[cert-rotation] Failed to read clientCertPath: ${err.message}`);
      }
    }
    if (!this.config.clientKey && this.config.clientKeyPath) {
      try {
        this.config.clientKey = fs.readFileSync(this.config.clientKeyPath);
      } catch (err: any) {
        console.error(`[cert-rotation] Failed to read clientKeyPath: ${err.message}`);
      }
    }

    const keepAlive = config.keepAlive ?? true;
    const maxSockets = config.maxSockets ?? 256;
    const maxFreeSockets = config.maxFreeSockets ?? 32;
    const keepAliveMsecs = config.keepAliveMsecs ?? 1000;
    const rejectUnauthorized = config.rejectUnauthorized ?? true;

    if (rejectUnauthorized === false) {
      console.warn(
        '[WARN] TLS certificate verification is explicitly DISABLED for upstream origin. This is insecure and vulnerable to MITM attacks.'
      );
    }

    this.httpAgent = new http.Agent({
      keepAlive,
      maxSockets,
      maxFreeSockets,
      keepAliveMsecs,
    });

    this.httpsAgent = new https.Agent({
      keepAlive,
      maxSockets,
      maxFreeSockets,
      keepAliveMsecs,
      rejectUnauthorized,
      ca: this.config.ca,
      cert: this.config.clientCert,
      key: this.config.clientKey,
    });

    if (
      this.config.watchCerts !== false &&
      (this.config.clientCertPath || this.config.clientKeyPath)
    ) {
      this.certWatcher = new CertificateFileWatcher(
        [this.config.clientCertPath, this.config.clientKeyPath],
        {
          onError: (err) => {
            console.error(`[cert-rotation] Upstream client cert watcher error: ${err.message}`);
            this.config.onCertError?.(err);
          },
          onReload: () => {
            this.reloadClientCertificates();
          },
        }
      );
    }
  }

  public getAgent(
    protocol: string,
    options?: {
      originId?: string;
      maxSockets?: number;
      rejectUnauthorized?: boolean;
      ca?: string | Buffer | Array<string | Buffer>;
      cert?: string | Buffer;
      key?: string | Buffer;
      lookup?: any;
    }
  ): http.Agent | https.Agent {
    const isHttps = protocol === 'https:';

    // If no custom origin, maxSockets, lookup, or custom TLS, return the standard agents
    if (
      !options?.originId &&
      options?.maxSockets === undefined &&
      options?.lookup === undefined &&
      options?.rejectUnauthorized === undefined &&
      options?.ca === undefined &&
      options?.cert === undefined &&
      options?.key === undefined
    ) {
      return isHttps ? this.httpsAgent : this.httpAgent;
    }

    const rejectUnauthorized = options?.rejectUnauthorized ?? this.config.rejectUnauthorized ?? true;
    if (rejectUnauthorized === false) {
      console.warn(
        '[WARN] TLS certificate verification is explicitly DISABLED for upstream origin. This is insecure and vulnerable to MITM attacks.'
      );
    }

    const ca = options?.ca ?? this.config.ca;
    const caKey = typeof ca === 'string' ? ca : Array.isArray(ca) ? `arr:${ca.length}` : Buffer.isBuffer(ca) ? ca.toString('base64') : 'none';
    const cert = options?.cert ?? this.config.clientCert;
    const key = options?.key ?? this.config.clientKey;
    const certKey = typeof cert === 'string' ? cert : Buffer.isBuffer(cert) ? cert.toString('base64') : 'none';
    const originKey = options?.originId ?? '';
    const maxSockets = options?.maxSockets ?? this.config.maxSockets ?? 256;
    const hasLookup = Boolean(options?.lookup);

    const cacheKey = `${protocol}:${originKey}:${maxSockets}:${rejectUnauthorized}:${caKey}:${certKey}:${hasLookup}`;
    let agent = this.agentCache.get(cacheKey);

    if (!agent) {
      const agentOptions = {
        keepAlive: this.config.keepAlive ?? true,
        maxSockets,
        maxFreeSockets: this.config.maxFreeSockets ?? 32,
        keepAliveMsecs: this.config.keepAliveMsecs ?? 1000,
        lookup: options?.lookup,
      };

      if (isHttps) {
        agent = new https.Agent({
          ...agentOptions,
          rejectUnauthorized,
          ca,
          cert,
          key,
        });
      } else {
        agent = new http.Agent(agentOptions);
      }

      this.agentCache.set(cacheKey, agent);

      if (options?.originId) {
        let set = this.originAgents.get(options.originId);
        if (!set) {
          set = new Set();
          this.originAgents.set(options.originId, set);
        }
        set.add(agent);
      }
    }

    return agent;
  }

  public getPoolStats(originId?: string): {
    activeSockets: number;
    freeSockets: number;
    pendingRequests: number;
  } {
    let targetAgents: (http.Agent | https.Agent)[] = [];

    if (originId) {
      const agents = this.originAgents.get(originId);
      if (agents) {
        targetAgents = Array.from(agents);
      }
    } else {
      targetAgents = [
        this.httpAgent,
        this.httpsAgent,
        ...Array.from(this.agentCache.values()),
      ];
    }

    let activeSockets = 0;
    let freeSockets = 0;
    let pendingRequests = 0;

    for (const agent of targetAgents) {
      if ((agent as any).sockets) {
        for (const sockets of Object.values((agent as any).sockets)) {
          if (Array.isArray(sockets)) {
            activeSockets += sockets.length;
          }
        }
      }
      if ((agent as any).freeSockets) {
        for (const sockets of Object.values((agent as any).freeSockets)) {
          if (Array.isArray(sockets)) {
            freeSockets += sockets.length;
          }
        }
      }
      if ((agent as any).requests) {
        for (const requests of Object.values((agent as any).requests)) {
          if (Array.isArray(requests)) {
            pendingRequests += requests.length;
          }
        }
      }
    }

    return {
      activeSockets,
      freeSockets,
      pendingRequests,
    };
  }

  public request(
    options: UpstreamRequestOptions,
    callback: (originRes: http.IncomingMessage) => void,
    onError: (err: any) => void
  ): http.ClientRequest {
    const isHttps = options.url.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const agent = this.getAgent(options.url.protocol, {
      originId: options.originId,
      maxSockets: options.maxSockets,
      rejectUnauthorized: options.rejectUnauthorized,
      ca: options.ca,
      cert: options.cert,
      key: options.key,
      lookup: options.lookup,
    });

    let hasRetried = false;
    let bodyHasStarted = false;
    let responseReceived = false;

    const execute = (isRetry: boolean): http.ClientRequest => {
      let isReusedSocket = false;

      const reqOptions: https.RequestOptions = {
        protocol: options.url.protocol,
        hostname: options.url.hostname,
        port: options.url.port || (isHttps ? 443 : 80),
        method: options.method,
        path: options.url.pathname + options.url.search,
        headers: options.headers,
        agent,
        signal: options.signal,
        servername: options.servername ?? options.url.hostname,
        rejectUnauthorized: options.rejectUnauthorized,
        ca: options.ca,
        cert: options.cert,
        key: options.key,
      };

      const upstreamReq = requestFn(reqOptions, (originRes) => {
        responseReceived = true;
        callback(originRes);
      });

      upstreamReq.on('information', (info: http.InformationEvent) => {
        if (options.onInformation) {
          options.onInformation(info);
        }
      });

      upstreamReq.on('socket', (socket: net.Socket) => {
        // In Node.js, socket.connecting is false for reused idle sockets from the agent pool
        isReusedSocket = !socket.connecting || (socket as any)._hadError || (socket as any)._bytesDispatched > 0;
      });

      upstreamReq.on('error', (err: any) => {
        if (
          !hasRetried &&
          !responseReceived &&
          shouldRetryOnStaleSocket(err, options.method, isReusedSocket, bodyHasStarted)
        ) {
          hasRetried = true;
          // Retry on a fresh connection
          execute(true);
          return;
        }

        onError(err);
      });

      if (options.bodyStream) {
        bodyHasStarted = true;
        options.bodyStream.pipe(upstreamReq);
      } else {
        upstreamReq.end();
      }

      return upstreamReq;
    };

    return execute(false);
  }

  public reloadClientCertificates(): void {
    if (!this.config.clientCertPath || !this.config.clientKeyPath) return;

    try {
      const certBuf = fs.readFileSync(this.config.clientCertPath);
      const keyBuf = fs.readFileSync(this.config.clientKeyPath);

      // Strictly validate new certificate and private key before applying
      loadAndValidateCertificate({ cert: certBuf, key: keyBuf });

      // Update config
      this.config.clientCert = certBuf;
      this.config.clientKey = keyBuf;

      // Recreate default httpsAgent
      this.httpsAgent = new https.Agent({
        keepAlive: this.config.keepAlive ?? true,
        maxSockets: this.config.maxSockets ?? 256,
        maxFreeSockets: this.config.maxFreeSockets ?? 32,
        keepAliveMsecs: this.config.keepAliveMsecs ?? 1000,
        rejectUnauthorized: this.config.rejectUnauthorized ?? true,
        ca: this.config.ca,
        cert: certBuf,
        key: keyBuf,
      });

      // Destroy cached agents so new connections negotiate with the new client cert
      for (const agent of this.agentCache.values()) {
        agent.destroy();
      }
      this.agentCache.clear();

      this.config.onCertRotate?.();
    } catch (err: any) {
      console.error(`[cert-rotation] Upstream client cert reload failed: ${err.message}`);
      this.config.onCertError?.(err);
    }
  }

  public destroy(): void {
    if (this.certWatcher) {
      this.certWatcher.close();
      this.certWatcher = undefined;
    }
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    for (const agent of this.agentCache.values()) {
      agent.destroy();
    }
    this.agentCache.clear();
    this.originAgents.clear();
  }

  public close(): void {
    this.destroy();
  }
}
