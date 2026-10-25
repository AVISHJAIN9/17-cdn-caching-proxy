import http from 'node:http';
import { CacheEntry } from './store.js';
import { RequestContext } from '../proxy/context.js';
import { Clock, SystemClock } from '../util/clock.js';
import { currentAgeMs } from './freshness.js';
import { formatHttpDate } from './http-date.js';
import { ensureVaryAcceptEncoding, negotiateEncoding } from '../compression/negotiate.js';
import { createCompressor, CompressionCodec } from '../compression/codecs.js';
import { isCompressibleContentType, ContentTypeRulesConfig } from '../compression/rules.js';
import { checkCompressionBypass, CompressionBypassConfig } from '../compression/bypass.js';
import { parseRangeHeader, evaluateIfRange } from '../range/parse-range.js';

export interface ServeHitOptions {
  entry: CacheEntry;
  clientRes: http.ServerResponse;
  clientReq?: http.IncomingMessage;
  debugHeaders?: boolean;
  requestId?: string;
  context?: RequestContext;
  clock?: Clock;
  extraHeaders?: Record<string, string | string[]>;
  compression?: {
    types?: ContentTypeRulesConfig;
    contentTypes?: ContentTypeRulesConfig;
    minBytes?: number;
    levels?: any;
    bypass?: CompressionBypassConfig;
  };
}

const MAX_AGE_HEADER_VALUE = 2147483648; // RFC 9111 cap at 2^31

/**
 * Serves a cached response directly from memory without contacting the origin:
 * - Answers with stored status and statusMessage.
 * - Stored headers + exact content-length + no transfer-encoding.
 * - Appends proxy's Via hop ("1.1 cdn-proxy"), preserving any existing Via.
 * - Adds X-Cache: HIT (when debugHeaders is true).
 * - Injects calculated RFC 9111 Age header (floor(currentAgeMs/1000), capped at 2147483648).
 *   Any previous origin Age header is removed and replaced.
 * - Replays stored origin Date header unchanged (or suppresses automatic Date if none was stored).
 * - Never exposes keyString or keyHash in any response header.
 * - Respects backpressure when writing bodies (writes and waits for drain).
 * - Handles client cancellation: if client aborts mid-hit, stops writing and releases resources.
 */
export async function serveCacheHit(options: ServeHitOptions): Promise<void> {
  const { entry, clientRes, debugHeaders = true, requestId, context, clock = new SystemClock(), extraHeaders } = options;

  if (context) {
    context.phase = 'streaming_body';
  }

  // Clone headers defensively to avoid mutating stored entry
  const responseHeaders: http.OutgoingHttpHeaders = { ...entry.headers };

  delete responseHeaders['transfer-encoding'];
  responseHeaders['content-length'] = entry.size;
  ensureVaryAcceptEncoding(responseHeaders as Record<string, string | string[] | undefined>);

  // Append proxy hop to Via header: "1.1 cdn-proxy"
  const existingVia = responseHeaders['via'];
  if (typeof existingVia === 'string' && existingVia.trim()) {
    responseHeaders['via'] = `${existingVia.trim()}, 1.1 cdn-proxy`;
  } else if (Array.isArray(existingVia)) {
    responseHeaders['via'] = `${existingVia.join(', ')}, 1.1 cdn-proxy`;
  } else {
    responseHeaders['via'] = '1.1 cdn-proxy';
  }

  // Remove any stored origin Age header, then send calculated Age header
  delete responseHeaders['age'];
  delete responseHeaders['Age'];

  const nowMs = clock.now();
  const ageMs = currentAgeMs(entry, nowMs);
  const ageSeconds = Math.min(MAX_AGE_HEADER_VALUE, Math.floor(ageMs / 1000));
  responseHeaders['age'] = ageSeconds.toString();

  if (debugHeaders) {
    responseHeaders['x-cache'] = 'HIT';
  }

  if (extraHeaders) {
    Object.assign(responseHeaders, extraHeaders);
  }

  if (requestId && !responseHeaders['x-request-id']) {
    responseHeaders['x-request-id'] = requestId;
  }

  const existingConn = clientRes.getHeader('connection') ?? clientRes.getHeader('Connection');
  if (existingConn !== undefined) {
    responseHeaders['connection'] =
      Array.isArray(existingConn) ? existingConn : String(existingConn);
  }

  responseHeaders['accept-ranges'] = 'bytes';

  // Evaluate Range & If-Range requests for cached objects (Feature 74 & 75)
  const rawRange = options.clientReq?.headers['range'];
  const rangeHeader = typeof rawRange === 'string' ? rawRange : Array.isArray(rawRange) ? rawRange[0] : undefined;
  if (rangeHeader) {
    const rawIfRange = options.clientReq?.headers['if-range'];
    const ifRangeHeader = typeof rawIfRange === 'string' ? rawIfRange : Array.isArray(rawIfRange) ? rawIfRange[0] : undefined;
    const etag =
      entry.etagRaw ??
      entry.etag?.raw ??
      (typeof responseHeaders['etag'] === 'string'
        ? responseHeaders['etag']
        : Array.isArray(responseHeaders['etag'])
        ? responseHeaders['etag'][0]
        : undefined);
    const lastModified =
      entry.lastModifiedRaw ??
      (typeof responseHeaders['last-modified'] === 'string'
        ? responseHeaders['last-modified']
        : Array.isArray(responseHeaders['last-modified'])
        ? responseHeaders['last-modified'][0]
        : undefined);
    const ifRangeMatches = evaluateIfRange(ifRangeHeader, etag, lastModified);

    if (ifRangeMatches) {
      const parsedRange = parseRangeHeader(rangeHeader, entry.body.length);
      if (parsedRange.type === 'valid') {
        const r = parsedRange.ranges[0];
        const slice = entry.body.subarray(r.start, r.end + 1);
        responseHeaders['content-range'] = `bytes ${r.start}-${r.end}/${entry.body.length}`;
        responseHeaders['content-length'] = slice.length;
        delete responseHeaders['content-encoding'];
        clientRes.sendDate = false;
        if (!clientRes.headersSent) {
          clientRes.writeHead(206, 'Partial Content', responseHeaders);
        }
        clientRes.end(slice);
        return;
      } else if (parsedRange.type === 'unsatisfiable') {
        responseHeaders['content-range'] = `bytes */${entry.body.length}`;
        delete responseHeaders['content-length'];
        delete responseHeaders['content-encoding'];
        clientRes.sendDate = false;
        if (!clientRes.headersSent) {
          clientRes.writeHead(416, 'Range Not Satisfiable', responseHeaders);
        }
        clientRes.end();
        return;
      }
    }
  }

  const rawAe = options.clientReq?.headers['accept-encoding'];
  const acceptEncodingHeader = typeof rawAe === 'string' ? rawAe : undefined;

  const negotiation = negotiateEncoding(acceptEncodingHeader);
  const bypassResult = checkCompressionBypass({
    method: options.clientReq?.method,
    statusCode: entry.status,
    requestHeaders: options.clientReq?.headers as Record<string, string | string[] | undefined>,
    responseHeaders: responseHeaders as Record<string, string | string[] | undefined>,
    bodyLength: entry.body.length,
    url: options.clientReq?.url,
    minBytes: options.compression?.minBytes,
    typesConfig: options.compression?.types ?? options.compression?.contentTypes,
    bypassConfig: options.compression?.bypass,
  });

  const shouldCompress =
    !bypassResult.shouldBypass &&
    negotiation.acceptable &&
    negotiation.encoding !== 'identity';

  if (bypassResult.shouldBypass && bypassResult.reason && (options.debugHeaders ?? true)) {
    responseHeaders['x-compression-bypass'] = bypassResult.reason;
  }

  if (shouldCompress) {
    delete responseHeaders['content-length'];
    responseHeaders['content-encoding'] = negotiation.encoding;
    if (
      responseHeaders['etag'] &&
      typeof responseHeaders['etag'] === 'string' &&
      !responseHeaders['etag'].startsWith('W/')
    ) {
      responseHeaders['etag'] = `W/${responseHeaders['etag']}`;
    }
  }

  clientRes.sendDate = false;

  if (!clientRes.headersSent) {
    clientRes.writeHead(entry.status, entry.statusMessage, responseHeaders);
  }

  if (shouldCompress) {
    const compressor = createCompressor(negotiation.encoding as CompressionCodec);
    compressor.pipe(clientRes);

    const body = entry.body;
    const chunkSize = 64 * 1024;
    let offset = 0;

    while (offset < body.length) {
      if (clientRes.destroyed || clientRes.socket?.destroyed || context?.signal?.aborted) {
        if (context) context.phase = 'aborted';
        compressor.destroy();
        return;
      }

      const end = Math.min(offset + chunkSize, body.length);
      const chunk = body.subarray(offset, end);
      offset = end;

      const canContinue = compressor.write(chunk);
      if (!canContinue && offset < body.length) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            compressor.removeListener('drain', onDrain);
            clientRes.removeListener('close', onClose);
          };
          compressor.on('drain', onDrain);
          clientRes.on('close', onClose);
        });
      }
    }

    compressor.end();
    if (context) {
      context.phase = 'completed';
    }
    return;
  }

  // Stream uncompressed body with backpressure
  const body = entry.body;
  const chunkSize = 64 * 1024;
  let offset = 0;

  while (offset < body.length) {
    // Check cancellation
    if (clientRes.destroyed || clientRes.socket?.destroyed || context?.signal?.aborted) {
      if (context) context.phase = 'aborted';
      return;
    }

    const end = Math.min(offset + chunkSize, body.length);
    const chunk = body.subarray(offset, end);
    offset = end;

    const canContinue = clientRes.write(chunk);
    if (!canContinue && offset < body.length) {
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clientRes.removeListener('drain', onDrain);
          clientRes.removeListener('close', onClose);
        };
        clientRes.on('drain', onDrain);
        clientRes.on('close', onClose);
      });
    }
  }

  clientRes.end();
  if (context) {
    context.phase = 'completed';
  }
}

/**
 * Serves a 304 Not Modified response directly from cache memory:
 * - Status 304, NO body.
 * - Headers: stored ETag, Last-Modified, Cache-Control, Expires, Content-Location, Date (the stored Date),
 *   plus Age (Batch 5 calculation), Via ("1.1 cdn-proxy"), X-Cache: HIT when debugHeaders.
 * - Does NOT send Content-Length, Content-Type, Content-Encoding, Content-Range, Transfer-Encoding or body headers.
 */
export function serveCache304(options: ServeHitOptions): void {
  const { entry, clientRes, debugHeaders = true, requestId, clock = new SystemClock(), extraHeaders } = options;

  clientRes.sendDate = false;
  const responseHeaders: http.OutgoingHttpHeaders = {};

  const etagVal = entry.headers['etag'];
  if (etagVal) {
    const rawVal = Array.isArray(etagVal) ? etagVal[0] : etagVal;
    const rawAe = options.clientReq?.headers['accept-encoding'];
    const acceptEncodingHeader = typeof rawAe === 'string' ? rawAe : undefined;
    const negotiation = negotiateEncoding(acceptEncodingHeader);
    const bypassResult = checkCompressionBypass({
      method: options.clientReq?.method,
      statusCode: 200,
      requestHeaders: options.clientReq?.headers as Record<string, string | string[] | undefined>,
      responseHeaders: entry.headers as Record<string, string | string[] | undefined>,
      bodyLength: entry.body.length,
      url: options.clientReq?.url,
      minBytes: options.compression?.minBytes,
      typesConfig: options.compression?.types ?? options.compression?.contentTypes,
      bypassConfig: options.compression?.bypass,
    });
    const wouldCompress =
      !bypassResult.shouldBypass &&
      negotiation.acceptable &&
      negotiation.encoding !== 'identity';

    if (wouldCompress && rawVal && typeof rawVal === 'string' && !rawVal.startsWith('W/')) {
      responseHeaders['etag'] = `W/${rawVal}`;
    } else {
      responseHeaders['etag'] = rawVal;
    }
  }
  const lmVal = entry.headers['last-modified'];
  if (lmVal) responseHeaders['last-modified'] = Array.isArray(lmVal) ? lmVal[0] : lmVal;
  const ccVal = entry.headers['cache-control'];
  if (ccVal) responseHeaders['cache-control'] = Array.isArray(ccVal) ? ccVal.join(', ') : ccVal;
  const expVal = entry.headers['expires'];
  if (expVal) responseHeaders['expires'] = Array.isArray(expVal) ? expVal[0] : expVal;
  const locVal = entry.headers['content-location'];
  if (locVal) responseHeaders['content-location'] = Array.isArray(locVal) ? locVal[0] : locVal;

  const dateVal = entry.headers['date'];
  responseHeaders['date'] = (Array.isArray(dateVal) ? dateVal[0] : dateVal) ?? formatHttpDate(clock.now());

  const nowMs = clock.now();
  const ageMs = currentAgeMs(entry, nowMs);
  const ageSeconds = Math.min(MAX_AGE_HEADER_VALUE, Math.floor(ageMs / 1000));
  responseHeaders['age'] = ageSeconds.toString();

  const existingVia = entry.headers['via'];
  if (typeof existingVia === 'string' && existingVia.trim()) {
    responseHeaders['via'] = `${existingVia.trim()}, 1.1 cdn-proxy`;
  } else if (Array.isArray(existingVia)) {
    responseHeaders['via'] = `${existingVia.join(', ')}, 1.1 cdn-proxy`;
  } else {
    responseHeaders['via'] = '1.1 cdn-proxy';
  }

  if (debugHeaders) {
    responseHeaders['x-cache'] = 'HIT';
  }
  if (extraHeaders) {
    Object.assign(responseHeaders, extraHeaders);
  }
  if (requestId && !responseHeaders['x-request-id']) {
    responseHeaders['x-request-id'] = requestId;
  }
  const existingConn = clientRes.getHeader('connection') ?? clientRes.getHeader('Connection');
  if (existingConn !== undefined) {
    responseHeaders['connection'] =
      Array.isArray(existingConn) ? existingConn : String(existingConn);
  }

  clientRes.writeHead(304, 'Not Modified', responseHeaders);
  clientRes.end();
  if (options.context) {
    options.context.phase = 'completed';
  }
}

export interface ServeStaleOptions extends ServeHitOptions {
  reason?: string;
  warning?: string;
}

/**
 * Serves a stale cached response directly to the client per RFC 9111 / RFC 5861.
 */
export async function serveCacheStale(options: ServeStaleOptions): Promise<void> {
  const extraHeaders: Record<string, string | string[]> = {
    ...options.extraHeaders,
  };
  if (options.debugHeaders ?? true) {
    extraHeaders['x-cache'] = 'STALE';
    if (options.reason) {
      extraHeaders['x-cache-reason'] = options.reason;
    }
  }
  if (options.warning) {
    extraHeaders['warning'] = options.warning;
  }
  return serveCacheHit({
    ...options,
    extraHeaders,
  });
}

