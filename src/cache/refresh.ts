/**
 * RFC 9111 §3.2 Freshness Revalidation and 304 Not Modified Header Merging.
 */

import { CacheEntry } from './store.js';
import { EntityTag, weakMatch } from './etag.js';
import { resolveResponseEtagInfo } from './policy.js';
import { resolveResponseLastModifiedInfo } from './validators.js';
import { resolveOriginResponseDate } from '../proxy/date.js';
import { parseCacheControl } from './cache-control.js';
import { freshnessLifetimeMs, LifetimeConfig } from './lifetime.js';
import { parseAgeHeader, currentAgeMs } from './freshness.js';

export interface RefreshContext {
  requestTimeMs: number;
  responseTimeMs: number;
  config?: LifetimeConfig;
  requestId?: string;
}

export type ApplyNotModifiedResult =
  | { kind: 'refreshed'; entry: CacheEntry }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'not_storable_anymore'; entry: CacheEntry };

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

const NEVER_TAKEN_FROM_304 = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'content-encoding',
  'content-range',
  'content-type',
  'transfer-encoding',
  'vary',
  'set-cookie',
  'age',
  'via',
]);

/**
 * Merges a 304 Not Modified response into a stored CacheEntry per RFC 9111 §3.2.
 *
 * 1. Validator Check:
 *    - If 304 has a valid ETag and stored entry has an etag: must weak-match, else kind mismatch.
 *    - If 304 has multiple or invalid ETag headers: treated as having no ETag (ignored).
 *    - If stored entry has no etag and 304 has a valid one: adopted.
 * 2. Header Merge:
 *    - Headers in 304 replace stored instances of the same name, EXCEPT excluded headers.
 *    - Date taken from 304 if valid, else proxy Date (formatHttpDate(responseTimeMs)).
 * 3. Freshness Recompute:
 *    - Recalculates freshnessLifetimeMs, dateValueMs, ageValueSeconds, currentAge.
 *    - If merged response is no longer storable (no-store, private, no-cache, lifetime <= 0, already stale):
 *      returns kind not_storable_anymore.
 * 4. Stored body, status code, status message, and body size are guaranteed unchanged.
 */
export function applyNotModified(
  entry: CacheEntry,
  resp304: {
    headers: Record<string, string | string[] | undefined>;
    rawHeaders?: string[];
  },
  ctx: RefreshContext
): ApplyNotModifiedResult {
  // 1. Validator Check (ETag)
  const etag304Info = resolveResponseEtagInfo(
    resp304.headers['etag'],
    resp304.rawHeaders,
    ctx.requestId
  );

  let refreshedEtag: EntityTag | undefined = entry.etag;
  let refreshedEtagRaw: string | undefined = entry.etagRaw;

  if (etag304Info) {
    if (entry.etag) {
      if (!weakMatch(etag304Info.etag, entry.etag)) {
        return { kind: 'mismatch', reason: 'etag_mismatch' };
      }
      refreshedEtag = etag304Info.etag;
      refreshedEtagRaw = etag304Info.raw;
    } else {
      refreshedEtag = etag304Info.etag;
      refreshedEtagRaw = etag304Info.raw;
    }
  }

  // Last-Modified resolution (RFC 9111 does not fail on Last-Modified mismatch)
  const lm304Info = resolveResponseLastModifiedInfo(
    resp304.headers['last-modified'],
    resp304.rawHeaders,
    ctx.requestId
  );
  let refreshedLastModifiedMs = entry.lastModifiedMs;
  let refreshedLastModifiedRaw = entry.lastModifiedRaw;
  if (lm304Info) {
    refreshedLastModifiedMs = lm304Info.ms;
    refreshedLastModifiedRaw = lm304Info.raw;
  }

  // 2. Header Merge
  const customHopByHop = new Set<string>();
  const connVal = resp304.headers['connection'];
  if (typeof connVal === 'string') {
    for (const part of connVal.split(',')) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) customHopByHop.add(trimmed);
    }
  } else if (Array.isArray(connVal)) {
    for (const item of connVal) {
      for (const part of item.split(',')) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) customHopByHop.add(trimmed);
      }
    }
  }

  const mergedHeaders: Record<string, string | string[]> = { ...entry.headers };

  for (const [key, val] of Object.entries(resp304.headers)) {
    if (val === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (NEVER_TAKEN_FROM_304.has(lowerKey) || customHopByHop.has(lowerKey)) {
      continue;
    }
    if (lowerKey === 'date' || lowerKey === 'etag' || lowerKey === 'last-modified') {
      continue;
    }

    mergedHeaders[lowerKey] = val;
  }

  // Resolve Date header: use 304 Date if valid, else proxy Date from responseTimeMs
  const resolvedDate = resolveOriginResponseDate(
    resp304.headers['date'],
    resp304.rawHeaders,
    ctx.responseTimeMs,
    ctx.requestId
  );
  mergedHeaders['date'] = resolvedDate.dateHeaderValue;

  // Apply updated ETag and Last-Modified if adopted
  if (refreshedEtagRaw !== undefined) {
    mergedHeaders['etag'] = refreshedEtagRaw;
  }
  if (refreshedLastModifiedRaw !== undefined) {
    mergedHeaders['last-modified'] = refreshedLastModifiedRaw;
  }

  // Ensure content-length reflects unchanged body length and transfer-encoding is deleted
  delete mergedHeaders['transfer-encoding'];
  mergedHeaders['content-length'] = entry.size.toString();

  // 3. Freshness Recompute
  const mergedCc = parseCacheControl(mergedHeaders['cache-control']);
  const rawExpires = mergedHeaders['expires'];
  const expiresHeader = Array.isArray(rawExpires) ? rawExpires[0] : rawExpires;

  const ageValueSeconds = parseAgeHeader(resp304.headers['age']);

  const lifetimeResult = freshnessLifetimeMs(
    {
      cacheControl: mergedCc,
      expiresHeader,
      dateMs: resolvedDate.dateValueMs,
      lastModifiedMs: refreshedLastModifiedMs,
    },
    ctx.config
  );

  const recomputeAge = currentAgeMs(
    {
      requestTimeMs: ctx.requestTimeMs,
      responseTimeMs: ctx.responseTimeMs,
      dateValueMs: resolvedDate.dateValueMs,
      ageValueSeconds,
    },
    ctx.responseTimeMs
  );

  const isNotStorable =
    mergedCc.noStore ||
    mergedCc.private ||
    mergedCc.noCache ||
    mergedCc.invalid.length > 0 ||
    lifetimeResult.source === 'none' ||
    lifetimeResult.source === 'invalid' ||
    lifetimeResult.lifetimeMs <= 0 ||
    recomputeAge >= lifetimeResult.lifetimeMs;

  const refreshedEntry: CacheEntry = {
    keyHash: entry.keyHash,
    keyString: entry.keyString,
    originId: entry.originId,
    status: entry.status,
    statusMessage: entry.statusMessage,
    headers: mergedHeaders,
    body: entry.body, // Must never be mutated or replaced
    size: entry.size, // Must match original
    storedAt: entry.storedAt,
    hitCount: entry.hitCount,
    lastAccessedAt: ctx.responseTimeMs,
    requestTimeMs: ctx.requestTimeMs,
    responseTimeMs: ctx.responseTimeMs,
    dateValueMs: resolvedDate.dateValueMs,
    ageValueSeconds,
    freshnessLifetimeMs: lifetimeResult.lifetimeMs,
    lifetimeSource: lifetimeResult.source,
    dateSource: resolvedDate.dateSource,
    etag: refreshedEtag,
    etagRaw: refreshedEtagRaw,
    lastModifiedMs: refreshedLastModifiedMs,
    lastModifiedRaw: refreshedLastModifiedRaw,
    refreshedAt: ctx.responseTimeMs,
    revalidationCount: (entry.revalidationCount ?? 0) + 1,
    version: entry.version,
  };

  if (isNotStorable) {
    return { kind: 'not_storable_anymore', entry: refreshedEntry };
  }

  return { kind: 'refreshed', entry: refreshedEntry };
}
