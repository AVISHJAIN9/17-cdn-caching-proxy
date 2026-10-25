import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ProxyRequest, sendJsonError } from './request.js';
import { resolveOriginResponseDate } from './date.js';
import {
  normalizeHeadersForForwarding,
  normalizeIncomingHeaders,
} from './headers.js';

export interface OriginConfig {
  url: string;
}

export interface ForwarderConfig {
  origin: OriginConfig;
  preserveHost?: boolean;
  trustForwardedHeaders?: boolean;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export class RequestForwarder {
  private originUrl: URL;
  private agent: http.Agent | https.Agent;
  private preserveHost: boolean;
  private trustForwardedHeaders: boolean;

  constructor(config: ForwarderConfig) {
    this.originUrl = new URL(config.origin.url);
    this.preserveHost = config.preserveHost ?? false;
    this.trustForwardedHeaders = config.trustForwardedHeaders ?? false;

    // Use one http.Agent per origin with default settings
    if (this.originUrl.protocol === 'https:') {
      this.agent = new https.Agent();
    } else {
      this.agent = new http.Agent();
    }
  }

  public getOriginUrl(): URL {
    return this.originUrl;
  }

  public forward(
    proxyReq: ProxyRequest,
    clientRes: http.ServerResponse,
    clientReq?: http.IncomingMessage
  ): void {
    // 1. Compute path + query from normalized URL
    let pathAndQuery = proxyReq.url;
    if (pathAndQuery.startsWith('http://') || pathAndQuery.startsWith('https://')) {
      try {
        const parsed = new URL(pathAndQuery);
        pathAndQuery = parsed.pathname + parsed.search;
      } catch {
        // fallback
      }
    }

    // 2. Prepare headers for forwarding upstream
    const originHost = this.originUrl.host;
    const isTls = proxyReq.url.startsWith('https://');

    const headersToSend = normalizeHeadersForForwarding(proxyReq.headers, {
      originHost,
      preserveHost: this.preserveHost,
      trustForwardedHeaders: this.trustForwardedHeaders,
      clientIp: proxyReq.remoteAddress,
      isTls,
    });

    const isHttpsOrigin = this.originUrl.protocol === 'https:';
    const requestFn = isHttpsOrigin ? https.request : http.request;

    const options: http.RequestOptions = {
      protocol: this.originUrl.protocol,
      hostname: this.originUrl.hostname,
      port: this.originUrl.port || (isHttpsOrigin ? 443 : 80),
      method: proxyReq.method,
      path: pathAndQuery,
      headers: headersToSend,
      agent: this.agent,
    };

    let originResReceived = false;

    const upstreamReq = requestFn(options, (originRes) => {
      originResReceived = true;

      // Filter hop-by-hop headers from origin response
      const responseHeaders: http.OutgoingHttpHeaders = {};
      const customHopByHop = new Set<string>();

      const connVal = originRes.headers['connection'];
      if (typeof connVal === 'string') {
        for (const part of connVal.split(',')) {
          const trimmed = part.trim().toLowerCase();
          if (trimmed) customHopByHop.add(trimmed);
        }
      }

      for (const [key, val] of Object.entries(originRes.headers)) {
        if (val === undefined) continue;
        const lowerKey = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lowerKey) || customHopByHop.has(lowerKey)) {
          continue;
        }
        responseHeaders[lowerKey] = val;
      }

      // Ensure X-Request-Id is present
      responseHeaders['x-request-id'] = proxyReq.id;

      const resolvedDate = resolveOriginResponseDate(
        originRes.headers['date'],
        originRes.rawHeaders,
        Date.now(),
        proxyReq.id
      );
      responseHeaders['date'] = resolvedDate.dateHeaderValue;

      clientRes.sendDate = false;
      if (!clientRes.headersSent) {
        clientRes.writeHead(
          originRes.statusCode ?? 200,
          originRes.statusMessage,
          responseHeaders
        );
      }

      // Stream origin response body to client
      originRes.pipe(clientRes);
    });

    // Minimal safety: if origin connection fails, return 502 with JSON error body
    upstreamReq.on('error', (err: any) => {
      if (!clientRes.headersSent) {
        sendJsonError(
          clientRes,
          502,
          'BAD_GATEWAY',
          `Origin connection failed: ${err.message}`,
          proxyReq.id
        );
      }
    });

    // Minimal safety: if client disconnects, destroy upstream request so sockets never leak
    let originResFinished = false;

    const abortUpstream = () => {
      if (!upstreamReq.destroyed && !originResFinished) {
        upstreamReq.destroy();
      }
    };

    if (clientReq) {
      clientReq.on('aborted', abortUpstream);
      clientReq.on('error', abortUpstream);
      clientReq.on('close', () => {
        if (!clientReq.complete && !clientRes.writableEnded) {
          abortUpstream();
        }
      });
    }

    clientRes.on('close', () => {
      if (!clientRes.writableEnded) {
        abortUpstream();
      }
    });

    clientRes.on('finish', () => {
      originResFinished = true;
    });

    // Stream client request body to origin without buffering
    proxyReq.body.pipe(upstreamReq);
  }
}
