import http from 'node:http';
import { parseUpstreamResponse, ParsedResponse } from './parse-response.js';
import { sendJsonError } from './request.js';
import { resolveOriginResponseDate } from './date.js';
import { Clock } from '../util/clock.js';

/**
 * Known limitation: Trailers are dropped in Batch 2 per specifications.
 */

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

const INTERNAL_RESPONSE_HEADER_PREFIXES = [
  'x-internal-',
  'x-origin-',
  'x-tenant-',
  'x-debug-',
  'x-proxy-debug',
  'x-server-',
  'x-powered-by',
];

export function isInternalResponseHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  return (
    lower === 'x-tenant-id' ||
    lower === 'x-tenant' ||
    lower === 'x-origin-id' ||
    lower === 'x-origin-url' ||
    lower === 'x-origin-pool' ||
    lower === 'x-proxy-debug' ||
    lower === 'x-powered-by' ||
    INTERNAL_RESPONSE_HEADER_PREFIXES.some((p) => lower.startsWith(p))
  );
}

export interface PreparedResponse {
  statusCode: number;
  statusMessage: string;
  headers: http.OutgoingHttpHeaders;
  isBodyless: boolean;
  parsed?: ParsedResponse;
}

/**
 * Normalizes and filters origin response headers for sending to the client:
 * - Removes hop-by-hop headers + any header named in the response's Connection header.
 * - Strips internal headers (debug, tenant, origin identity) to prevent information leaks.
 * - Preserves multiple set-cookie headers separately (never joined).
 * - Enforces Server and Via policy ("1.1 cdn-proxy", "cdn-proxy").
 * - Does NOT follow redirects; passes 3xx and Location through unchanged.
 * - Handles bodyless responses: HEAD, 204, 304 send no body. Keeps origin's content-length for HEAD.
 * - Enforces Date header rule: exactly ONE Date header, forwarded byte-identical if valid, or replaced with formatHttpDate(responseTime).
 */
export function prepareResponseHeaders(
  originStatusCode: number,
  originStatusMessage: string | undefined,
  originHeaders: http.IncomingHttpHeaders,
  requestMethod: string,
  rawHeaders?: string[],
  responseTimeMs?: number,
  clock?: Clock,
  requestId?: string,
  options?: { preserveOriginId?: boolean }
): PreparedResponse {
  const method = requestMethod.toUpperCase();
  const statusCode = originStatusCode;
  const statusMessage = originStatusMessage ?? (http.STATUS_CODES[statusCode] || '');

  // Bodyless responses: HEAD, 204 No Content, 304 Not Modified
  const isBodyless = method === 'HEAD' || statusCode === 204 || statusCode === 304;

  const headersObj = originHeaders || {};
  const customHopByHop = new Set<string>();
  const rawConn = headersObj['connection'] as string | string[] | undefined;
  if (typeof rawConn === 'string') {
    for (const part of rawConn.split(',')) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) customHopByHop.add(trimmed);
    }
  } else if (Array.isArray(rawConn)) {
    for (const item of rawConn) {
      for (const part of item.split(',')) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) customHopByHop.add(trimmed);
      }
    }
  }

  const outgoingHeaders: http.OutgoingHttpHeaders = {};

  for (const [key, val] of Object.entries(originHeaders)) {
    if (val === undefined) continue;
    const lowerKey = key.toLowerCase();

    // Remove hop-by-hop headers
    if (HOP_BY_HOP_HEADERS.has(lowerKey) || customHopByHop.has(lowerKey)) {
      continue;
    }

    // Remove internal headers to prevent information leaks
    if (isInternalResponseHeader(lowerKey)) {
      if (lowerKey === 'x-origin-id' && options?.preserveOriginId) {
        // preserve x-origin-id for multi-origin routed responses
      } else {
        continue;
      }
    }

    // Set-Cookie must be preserved as array if multiple
    if (lowerKey === 'set-cookie') {
      if (Array.isArray(val)) {
        outgoingHeaders['set-cookie'] = [...val];
      } else {
        outgoingHeaders['set-cookie'] = [val];
      }
      continue;
    }

    // For 204 and 304, Content-Length must not be sent per RFC 9110
    if ((statusCode === 204 || statusCode === 304) && lowerKey === 'content-length') {
      continue;
    }

    // For HEAD, we DO keep the origin's Content-Length
    outgoingHeaders[lowerKey] = val;
  }

  // If upstream response was chunked, remove Content-Length for non-HEAD responses (RFC 9112 §6.3)
  const rawTe = originHeaders['transfer-encoding'];
  let isChunked = false;
  if (typeof rawTe === 'string') {
    isChunked = rawTe.toLowerCase().includes('chunked');
  } else if (Array.isArray(rawTe)) {
    isChunked = (rawTe as string[]).some((t) => typeof t === 'string' && t.toLowerCase().includes('chunked'));
  }
  if (isChunked && method !== 'HEAD') {
    delete outgoingHeaders['content-length'];
  }

  // Resolve Date header per RFC 9111 & Batch 6 Rule a:
  // - If origin sent exactly ONE Date header that parseHttpDate accepts, forward it unchanged.
  // - If Date is missing, invalid, or appears more than once, REPLACE it with formatHttpDate(responseReceivedTime)
  //   from the injected Clock (log date_missing or date_invalid with requestId).
  const resolvedDate = resolveOriginResponseDate(
    originHeaders['date'],
    rawHeaders,
    responseTimeMs ?? (clock ? clock.now() : Date.now()),
    requestId
  );
  outgoingHeaders['date'] = resolvedDate.dateHeaderValue;

  // Append proxy hop to Via header: "1.1 cdn-proxy"
  const existingVia = originHeaders['via'];
  if (typeof existingVia === 'string' && existingVia.trim()) {
    outgoingHeaders['via'] = `${existingVia.trim()}, 1.1 cdn-proxy`;
  } else if (Array.isArray(existingVia)) {
    outgoingHeaders['via'] = `${existingVia.join(', ')}, 1.1 cdn-proxy`;
  } else {
    outgoingHeaders['via'] = '1.1 cdn-proxy';
  }

  // Server header policy: default to "cdn-proxy" if not already set
  if (!outgoingHeaders['server']) {
    outgoingHeaders['server'] = 'cdn-proxy';
  }

  return {
    statusCode,
    statusMessage,
    headers: outgoingHeaders,
    isBodyless,
  };
}

/**
 * Writes the normalized response headers to client response.
 * If response is bodyless, closes clientRes immediately.
 */
export function forwardResponseHeaders(
  originRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  requestMethod: string,
  requestId?: string,
  extraHeaders?: Record<string, string | string[]>,
  clock?: Clock,
  responseTimeMs?: number,
  compressionOptions: { compressor?: any; decompressor?: any; preserveOriginId?: boolean } = {}
): { isBodyless: boolean; parsed: ParsedResponse } {
  let parsed: ParsedResponse;
  try {
    parsed = parseUpstreamResponse(originRes, { requestMethod });
  } catch (err: any) {
    if (!clientRes.headersSent) {
      sendJsonError(
        clientRes,
        err.statusCode ?? 502,
        err.code ?? 'UPSTREAM_INVALID_RESPONSE',
        err.message,
        requestId ?? 'unknown'
      );
    }
    throw err;
  }

  const prepared = prepareResponseHeaders(
    parsed.statusCode,
    parsed.statusMessage,
    originRes.headers,
    requestMethod,
    originRes.rawHeaders,
    responseTimeMs,
    clock,
    requestId,
    { preserveOriginId: compressionOptions.preserveOriginId }
  );

  if (requestId && !prepared.headers['x-request-id']) {
    prepared.headers['x-request-id'] = requestId;
  }

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      const lower = k.toLowerCase();
      if (lower === 'vary') {
        const existing = prepared.headers['vary'];
        if (existing) {
          const parts = String(existing).split(',').map((s) => s.trim()).filter(Boolean);
          const newParts = (Array.isArray(v) ? v.join(', ') : String(v)).split(',').map((s) => s.trim()).filter(Boolean);
          for (const np of newParts) {
            if (!parts.some((p) => p.toLowerCase() === np.toLowerCase())) {
              parts.push(np);
            }
          }
          prepared.headers['vary'] = parts.join(', ');
        } else {
          prepared.headers['vary'] = Array.isArray(v) ? v.join(', ') : String(v);
        }
      } else {
        prepared.headers[lower] = v;
      }
    }
  }

  if (compressionOptions.compressor) {
    delete prepared.headers['content-length'];
    if (prepared.headers['etag'] && typeof prepared.headers['etag'] === 'string' && !prepared.headers['etag'].startsWith('W/')) {
      prepared.headers['etag'] = `W/${prepared.headers['etag']}`;
    }
  }

  if (compressionOptions.decompressor) {
    delete prepared.headers['content-length'];
    delete prepared.headers['content-encoding'];
  }

  const existingConn = clientRes.getHeader('connection') ?? clientRes.getHeader('Connection');
  if (existingConn !== undefined) {
    prepared.headers['connection'] = Array.isArray(existingConn) ? existingConn : String(existingConn);
  }

  clientRes.sendDate = false;
  if (!clientRes.headersSent) {
    clientRes.writeHead(prepared.statusCode, prepared.statusMessage, prepared.headers);
  }

  if (prepared.isBodyless) {
    clientRes.end();
  }

  return { isBodyless: prepared.isBodyless, parsed };
}
