import http from 'node:http';
import { ProxyError, mapSystemError } from './errors.js';
import { RequestContext } from './context.js';
import { formatHttpDate } from '../cache/http-date.js';

export interface SendErrorContext {
  requestId: string;
  method?: string;
}

/**
 * Sanitizes any string to ensure no stack traces, file paths, internal IPs, or origin hostnames leak.
 */
function sanitizeClientMessage(message: string): string {
  if (!message) return 'An error occurred';

  // If message looks like a stack trace, internal path, or code snippet, replace with generic text
  if (
    message.includes('at ') ||
    message.includes('.ts') ||
    message.includes('.js') ||
    message.includes('node_modules') ||
    message.includes('/Users') ||
    message.includes('/home') ||
    message.includes('Error:')
  ) {
    return 'An internal error occurred processing your request';
  }

  // Strip potential file path prefixes if present
  let sanitized = message.replace(/(?:\/[a-zA-Z0-9_\-\.]+)+/g, '[path]');
  // Strip potential IP:port patterns
  sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[origin]');
  return sanitized;
}

/**
 * Central function to send proxy-generated error responses to the client.
 * This is the ONLY place in the proxy that writes proxy-generated error responses.
 */
export function sendError(
  ctx: RequestContext | SendErrorContext | undefined,
  res: http.ServerResponse,
  err: ProxyError | Error | any
): void {
  const requestId = ctx?.requestId ?? (res as any).__requestId ?? 'unknown';
  const method = (
    (ctx as any)?.method ??
    (res as any).req?.method ??
    'GET'
  ).toUpperCase();

  // If headers were already sent, we cannot send an HTTP error response.
  // Destroy the socket and log it server-side.
  if (res.headersSent) {
    if (res.socket && !res.socket.destroyed) {
      res.socket.destroy();
    }
    console.error(
      `headers_already_sent_cannot_send_error requestId=${requestId} error=${err?.message ?? String(err)}`
    );
    return;
  }

  // Normalize error to a typed ProxyError
  let proxyError: ProxyError;
  if (err instanceof ProxyError) {
    proxyError = err;
  } else {
    proxyError = mapSystemError(err);
  }

  // Server-side logging of full error detail with requestId (never exposed to client)
  const fullDetail = err?.stack || err?.message || String(err);
  console.error(
    `[proxy-error] requestId=${requestId} code=${proxyError.code} status=${proxyError.status} detail=${fullDetail}`
  );

  const safeMessage = sanitizeClientMessage(proxyError.publicMessage);

  const payload = JSON.stringify({
    error: {
      code: proxyError.code,
      message: safeMessage,
      requestId,
    },
  });

  const payloadBytes = Buffer.byteLength(payload);
  const clock = (ctx as any)?.clock ?? (res as any).__clock;
  const nowMs = clock ? clock.now() : Date.now();

  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
    'Content-Length': payloadBytes,
    Connection: 'close',
    Date: formatHttpDate(nowMs),
  };

  res.sendDate = false;

  if (proxyError.allowHeader) {
    headers['Allow'] = proxyError.allowHeader;
  }

  // HEAD gets headers only, with no body
  if (method === 'HEAD') {
    res.writeHead(proxyError.status, headers);
    res.end();
    return;
  }

  res.writeHead(proxyError.status, headers);
  res.end(payload);
}
