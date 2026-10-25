import http from 'node:http';
import https from 'node:https';

export interface KeepAliveOptions {
  maxRequestsPerSocket?: number; // default 1000
  maxConnections?: number;       // default 10000
  keepAliveTimeoutMs?: number;   // default 5000
}

/**
 * Pure function: determines if an incoming client request requests connection keep-alive.
 * - HTTP/1.1 is persistent by default unless Connection: close
 * - HTTP/1.0 closes by default unless Connection: keep-alive
 */
export function shouldKeepAlive(req: http.IncomingMessage): boolean {
  const connectionHeader = req.headers['connection'];
  const connStr = Array.isArray(connectionHeader)
    ? connectionHeader.join(', ')
    : connectionHeader ?? '';

  if (req.httpVersion === '1.0') {
    return /keep-alive/i.test(connStr);
  }

  // HTTP/1.1 (and future HTTP/1.x): persistent by default unless Connection: close
  return !/close/i.test(connStr);
}

/**
 * Pure function: determines if the response to the client should include Connection: close.
 * Returns true if:
 * 1. Server is shutting down (graceful drain)
 * 2. Socket request count has reached or exceeded maxRequestsPerSocket
 * 3. Client requested Connection: close, or HTTP/1.0 without keep-alive
 */
export function shouldSendConnectionClose(
  req: http.IncomingMessage,
  options: {
    isShuttingDown?: boolean;
    requestsOnSocket?: number;
    maxRequestsPerSocket?: number;
  } = {}
): boolean {
  if (options.isShuttingDown) {
    return true;
  }

  if (
    options.maxRequestsPerSocket !== undefined &&
    options.requestsOnSocket !== undefined &&
    options.requestsOnSocket >= options.maxRequestsPerSocket
  ) {
    return true;
  }

  return !shouldKeepAlive(req);
}

/**
 * Configures keep-alive, connection limits, and timeouts on an http or https Server instance.
 */
export function configureServerKeepAlive(
  server: http.Server | https.Server,
  options: KeepAliveOptions = {}
): void {
  const maxConnections = options.maxConnections ?? 10000;
  const maxRequestsPerSocket = options.maxRequestsPerSocket ?? 1000;
  const keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? 5000;

  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = maxRequestsPerSocket;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  // Node recommends headersTimeout > keepAliveTimeout to prevent race conditions
  server.headersTimeout = Math.max(server.headersTimeout, keepAliveTimeoutMs + 1000);
}
