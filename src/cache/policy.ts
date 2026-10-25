/**
 * RFC 9111 Cache Policy & Storability Engine.
 * Replaces temp-policy.ts.
 */

import { parseCacheControl } from './cache-control.js';
import { freshnessLifetimeMs, LifetimeConfig, LifetimeSource } from './lifetime.js';
import { parseResponseDate, parseAgeHeader, currentAgeMs } from './freshness.js';

export interface CachePolicyOptions {
  enabled?: boolean; // default true
  bypassOnCookie?: boolean; // default true
  maxTtlMs?: number; // default 86400000 (1 day)
  minTtlMs?: number; // default 0
  enableRangeCache?: boolean; // default false
}

export type BypassReason =
  | 'cache_disabled'
  | 'method_not_cacheable'
  | 'has_authorization'
  | 'has_cookie'
  | 'has_range'
  | 'conditional_request'
  | 'client_no_cache'
  | 'client_no_store'
  | 'client_max_age_zero'
  | 'cache_error';

export function checkRequestBypass(
  req: {
    method?: string;
    headers: NodeJS.Dict<string | string[]> | Record<string, string | string[] | undefined>;
  },
  options: CachePolicyOptions = {}
): { bypass: boolean; reason?: BypassReason } {
  if (options.enabled === false) {
    return { bypass: true, reason: 'cache_disabled' };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  // Batch 4 & 5 scope fence: only GET is cached (HEAD also bypasses in this batch)
  if (method !== 'GET') {
    return { bypass: true, reason: 'method_not_cacheable' };
  }

  // Authorization header bypass
  if (req.headers['authorization']) {
    return { bypass: true, reason: 'has_authorization' };
  }

  // Cookie header bypass (when bypassOnCookie is true)
  const bypassOnCookie = options.bypassOnCookie ?? true;
  if (bypassOnCookie && req.headers['cookie']) {
    return { bypass: true, reason: 'has_cookie' };
  }

  // Range header bypass (unless range caching is enabled)
  if (!options.enableRangeCache && req.headers['range']) {
    return { bypass: true, reason: 'has_range' };
  }

  // Conditional request headers that still bypass: If-Match, If-Unmodified-Since
  if (req.headers['if-match'] || req.headers['if-unmodified-since']) {
    return { bypass: true, reason: 'conditional_request' };
  }
  if (!options.enableRangeCache && req.headers['if-range']) {
    return { bypass: true, reason: 'conditional_request' };
  }

  // Parse request Cache-Control
  const ccHeader = req.headers['cache-control'];
  const reqCc = parseCacheControl(ccHeader);

  // Check Pragma: no-cache
  const pragmaHeader = req.headers['pragma'];
  let pragmaNoCache = false;
  if (pragmaHeader) {
    const pragmaParts = Array.isArray(pragmaHeader)
      ? pragmaHeader.join(',').split(',')
      : pragmaHeader.split(',');
    for (const part of pragmaParts) {
      if (part.trim().toLowerCase() === 'no-cache') {
        pragmaNoCache = true;
        break;
      }
    }
  }

  if (reqCc.noStore) {
    return { bypass: true, reason: 'client_no_store' };
  }
  if (reqCc.noCache || pragmaNoCache) {
    return { bypass: true, reason: 'client_no_cache' };
  }
  if (reqCc.maxAge === 0) {
    return { bypass: true, reason: 'client_no_cache' };
  }

  return { bypass: false };
}

export type StorabilityReason =
  | 'status_not_200'
  | 'has_set_cookie'
  | 'has_vary'
  | 'no_store'
  | 'private'
  | 'no_cache'
  | 'invalid_cache_control'
  | 'no_freshness_info'
  | 'zero_lifetime'
  | 'already_stale'
  | 'body_incomplete'
  | 'client_aborted'
  | 'too_large'
  | 'cache_full'
  | 'authorization_not_allowed';

import { resolveOriginResponseDate } from '../proxy/date.js';
import { EntityTag, parseEntityTag } from './etag.js';
import { resolveResponseLastModified, resolveResponseLastModifiedInfo } from './validators.js';

export function resolveResponseEtagInfo(
  etagHeader: string | string[] | undefined,
  rawHeaders: string[] | undefined,
  requestId?: string
): { etag: EntityTag; raw: string } | undefined {
  let count = 0;
  if (rawHeaders) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'etag') {
        count++;
      }
    }
  } else if (Array.isArray(etagHeader)) {
    count = etagHeader.length;
  } else if (etagHeader !== undefined) {
    count = 1;
  }

  if (count === 0 || etagHeader === undefined) {
    return undefined;
  }

  if (count > 1) {
    console.warn(`etag_multiple: origin sent multiple ETag headers requestId=${requestId ?? 'unknown'}`);
    return undefined;
  }

  const raw = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;
  const parsed = parseEntityTag(raw);
  if (!parsed) {
    console.warn(`etag_invalid: origin ETag header '${raw}' is invalid requestId=${requestId ?? 'unknown'}`);
    return undefined;
  }

  return { etag: parsed, raw };
}

export function resolveResponseEtag(
  etagHeader: string | string[] | undefined,
  rawHeaders: string[] | undefined,
  requestId?: string
): EntityTag | undefined {
  return resolveResponseEtagInfo(etagHeader, rawHeaders, requestId)?.etag;
}

export interface StorableMetadata {
  requestTimeMs: number;
  responseTimeMs: number;
  dateValueMs: number;
  ageValueSeconds: number;
  freshnessLifetimeMs: number;
  lifetimeSource: LifetimeSource;
  resolvedDateHeader: string;
  dateSource: 'origin' | 'proxy_added';
  etag?: EntityTag;
  etagRaw?: string;
  lastModifiedMs?: number;
  lastModifiedRaw?: string;
}

export interface CheckStorableInput {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
  requestTimeMs: number;
  responseTimeMs: number;
  config?: LifetimeConfig;
  requestId?: string;
  hasAuthorization?: boolean;
}

export function checkResponseStorableFromHeaders(
  input: CheckStorableInput
): { storable: boolean; reason?: StorabilityReason; metadata?: StorableMetadata } {
  // 1. Response status must be exactly 200
  if (input.statusCode !== 200) {
    return { storable: false, reason: 'status_not_200' };
  }

  // 2. Set-Cookie policy: responses with Set-Cookie are not stored unless explicitly configured
  const allowSetCookie = (input.config as any)?.allowSetCookie ?? false;
  if (!allowSetCookie && input.headers['set-cookie'] !== undefined) {
    return { storable: false, reason: 'has_set_cookie' };
  }

  // 3. No Vary header
  if (input.headers['vary'] !== undefined) {
    return { storable: false, reason: 'has_vary' };
  }

  // 4. Parse Cache-Control header
  const cc = parseCacheControl(input.headers['cache-control']);

  if (cc.noStore) {
    return { storable: false, reason: 'no_store' };
  }
  if (cc.private) {
    return { storable: false, reason: 'private' };
  }
  if (cc.noCache) {
    return { storable: false, reason: 'no_cache' };
  }
  if (cc.invalid.length > 0) {
    return { storable: false, reason: 'invalid_cache_control' };
  }

  // 4b. RFC 9111 Section 3.5: Authorization in request
  if (input.hasAuthorization && !cc.public && cc.sMaxAge === undefined && !cc.mustRevalidate) {
    return { storable: false, reason: 'authorization_not_allowed' };
  }

  // 5. Parse Date and Age headers
  const resolvedDate = resolveOriginResponseDate(
    input.headers['date'],
    input.rawHeaders,
    input.responseTimeMs,
    input.requestId
  );
  const dateValueMs = resolvedDate.dateValueMs;
  const ageValueSeconds = parseAgeHeader(input.headers['age']);

  // 6. Calculate Freshness Lifetime
  const rawExpires = input.headers['expires'];
  const expiresHeader = Array.isArray(rawExpires) ? rawExpires[0] : rawExpires;
  const lmInfo = resolveResponseLastModifiedInfo(
    input.headers['last-modified'],
    input.rawHeaders,
    input.requestId
  );
  const lastModifiedMs = lmInfo?.ms;
  const lastModifiedRaw = lmInfo?.raw;
  const lifetimeResult = freshnessLifetimeMs(
    {
      cacheControl: cc,
      expiresHeader,
      dateMs: dateValueMs,
      lastModifiedMs,
    },
    input.config
  );

  if (lifetimeResult.source === 'none') {
    return { storable: false, reason: 'no_freshness_info' };
  }
  if (lifetimeResult.source === 'invalid') {
    return { storable: false, reason: 'invalid_cache_control' };
  }
  if (lifetimeResult.lifetimeMs <= 0) {
    return { storable: false, reason: 'zero_lifetime' };
  }

  // 7. Check if already stale at arrival
  const ageAtStore = currentAgeMs(
    {
      requestTimeMs: input.requestTimeMs,
      responseTimeMs: input.responseTimeMs,
      dateValueMs,
      ageValueSeconds,
    },
    input.responseTimeMs
  );

  if (ageAtStore >= lifetimeResult.lifetimeMs) {
    return { storable: false, reason: 'already_stale' };
  }

  const etagInfo = resolveResponseEtagInfo(input.headers['etag'], input.rawHeaders, input.requestId);
  const etag = etagInfo?.etag;
  const etagRaw = etagInfo?.raw;

  return {
    storable: true,
    metadata: {
      requestTimeMs: input.requestTimeMs,
      responseTimeMs: input.responseTimeMs,
      dateValueMs,
      ageValueSeconds,
      freshnessLifetimeMs: lifetimeResult.lifetimeMs,
      lifetimeSource: lifetimeResult.source,
      resolvedDateHeader: resolvedDate.dateHeaderValue,
      dateSource: resolvedDate.dateSource,
      etag,
      etagRaw,
      lastModifiedMs,
      lastModifiedRaw,
    },
  };
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

/**
 * Filters origin headers for cache storage according to Batch 2 hop-by-hop rules:
 * - Removes hop-by-hop headers and any header named in the Connection header.
 * - Removes transfer-encoding.
 * - Never stores set-cookie.
 * - Preserves content-type, content-encoding, etc.
 * - Updates content-length to reflect actual body size.
 */
export function filterStoredHeaders(
  originHeaders: Record<string, string | string[] | undefined>,
  bodyLength: number,
  resolvedDateHeader?: string
): Record<string, string | string[]> {
  const customHopByHop = new Set<string>();
  const rawConn = originHeaders['connection'];
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

  const storedHeaders: Record<string, string | string[]> = {};

  for (const [key, val] of Object.entries(originHeaders)) {
    if (val === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lowerKey) || customHopByHop.has(lowerKey)) {
      continue;
    }
    if (lowerKey === 'set-cookie') {
      continue;
    }

    storedHeaders[lowerKey] = val;
  }

  if (resolvedDateHeader !== undefined) {
    storedHeaders['date'] = resolvedDateHeader;
  }

  // Ensure content-length is exact stored body size and transfer-encoding is removed
  delete storedHeaders['transfer-encoding'];
  storedHeaders['content-length'] = bodyLength.toString();

  return storedHeaders;
}
