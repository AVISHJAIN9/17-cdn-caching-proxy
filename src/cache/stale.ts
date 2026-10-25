import { CacheEntry } from './store.js';
import { parseCacheControl } from './cache-control.js';
import { currentAgeMs } from './freshness.js';

/**
 * Pure function: allowsStaleServing(entry) -> boolean
 *
 * RFC 9111 Section 5.2.2.2 (must-revalidate):
 * Once it has become stale, a cache MUST NOT use the response to satisfy subsequent
 * requests without successful validation on the origin server.
 *
 * RFC 9111 Section 5.2.2.9 (proxy-revalidate):
 * Has the same meaning as must-revalidate, except that it does not apply to private user agent caches.
 * For this shared proxy cache, proxy-revalidate strictly forbids serving stale.
 *
 * RFC 9111 Section 5.2.2.10 (s-maxage):
 * Incorporates proxy-revalidate semantics for shared caches: once expired, it cannot be used
 * stale without revalidation.
 */
export function allowsStaleServing(entry: CacheEntry): boolean {
  const ccHeader = entry.headers['cache-control'];
  const cc = parseCacheControl(ccHeader);

  // If must-revalidate, proxy-revalidate, or s-maxage was present,
  // stale serving is strictly forbidden by RFC 9111.
  if (cc.mustRevalidate || cc.proxyRevalidate || cc.sMaxAge !== undefined) {
    return false;
  }

  // Under RFC 5861, stale serving is permitted if stale-while-revalidate
  // or stale-if-error directive is present.
  return Boolean(
    (cc.staleWhileRevalidate !== undefined && cc.staleWhileRevalidate > 0) ||
    (cc.staleIfError !== undefined && cc.staleIfError > 0)
  );
}

/**
 * Checks if the entry is currently within its stale-while-revalidate window per RFC 5861 Section 3.
 */
export function isWithinStaleWhileRevalidate(entry: CacheEntry, nowMs: number): boolean {
  if (!allowsStaleServing(entry)) {
    return false;
  }
  const ccHeader = entry.headers['cache-control'];
  const cc = parseCacheControl(ccHeader);
  if (cc.staleWhileRevalidate === undefined || cc.staleWhileRevalidate <= 0) {
    return false;
  }
  const age = currentAgeMs(entry, nowMs);
  const staleWindowMs = cc.staleWhileRevalidate * 1000;
  return age >= entry.freshnessLifetimeMs && age < entry.freshnessLifetimeMs + staleWindowMs;
}

/**
 * Checks if the entry is currently within its stale-if-error window per RFC 5861 Section 4.
 */
export function isWithinStaleIfError(
  entry: CacheEntry,
  nowMs: number,
  clientStaleIfError?: number
): boolean {
  const ccHeader = entry.headers['cache-control'];
  const cc = parseCacheControl(ccHeader);
  if (cc.mustRevalidate || cc.proxyRevalidate || cc.sMaxAge !== undefined) {
    return false;
  }
  const staleIfErrorSec = cc.staleIfError ?? clientStaleIfError;
  if (staleIfErrorSec === undefined || staleIfErrorSec <= 0) {
    return false;
  }
  const age = currentAgeMs(entry, nowMs);
  const staleWindowMs = staleIfErrorSec * 1000;
  return age >= entry.freshnessLifetimeMs && age < entry.freshnessLifetimeMs + staleWindowMs;
}

