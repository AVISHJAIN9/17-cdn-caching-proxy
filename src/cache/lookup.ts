import { CacheStore, CacheEntry } from './store.js';
import { CacheKey } from './key.js';
import { Clock } from '../util/clock.js';
import { checkRequestBypass, CachePolicyOptions, BypassReason } from './policy.js';
import { parseCacheControl } from './cache-control.js';
import { isFresh } from './freshness.js';
import { buildUpstreamConditionals } from './upstream-conditionals.js';
import { isWithinStaleWhileRevalidate, allowsStaleServing } from './stale.js';

export type LookupResult =
  | { result: 'hit'; entry: CacheEntry }
  | { result: 'miss'; reason: 'not_found' | 'expired' }
  | { result: 'stale'; entry: CacheEntry; reason: 'expired'; staleWhileRevalidate?: boolean }
  | { result: 'bypass'; reason: BypassReason };

export interface CacheLookupOptions extends CachePolicyOptions {
  requestId?: string;
  revalidate?: {
    enabled?: boolean;
  };
}

/**
 * Performs cache lookup for a request:
 * 1. Checks bypass conditions (method != GET, auth, cookie, range, conditional, no-cache, disabled)
 * 2. Queries CacheStore by keyHash
 * 3. Checks SHA-256 key collision
 * 4. Checks freshness / stale-with-validators eligibility
 * 5. Handles internal errors gracefully without failing client request
 */
export function lookupCache(
  req: {
    method?: string;
    headers: NodeJS.Dict<string | string[]> | Record<string, string | string[] | undefined>;
  },
  key: CacheKey,
  store: CacheStore,
  clock: Clock,
  options: CacheLookupOptions = {}
): LookupResult {
  const requestId = options.requestId ?? 'unknown';

  try {
    let resolvedEntry: CacheEntry | undefined;

    // 1. Check bypass rules
    const bypassCheck = checkRequestBypass(req, options);
    if (bypassCheck.bypass && bypassCheck.reason) {
      if (bypassCheck.reason === 'has_authorization') {
        // RFC 9111 Section 3.5: If cached response explicitly allows shared-cache reuse
        // (public, s-maxage, or must-revalidate), Authorization header does not bypass.
        const potentialEntry = store.get(key.keyHash);
        if (potentialEntry && potentialEntry.keyString === key.keyString) {
          const cc = parseCacheControl(potentialEntry.headers['cache-control']);
          if (cc.public || cc.sMaxAge !== undefined || cc.mustRevalidate) {
            resolvedEntry = potentialEntry;
          } else {
            store.recordBypass();
            return { result: 'bypass', reason: 'has_authorization' };
          }
        } else {
          store.recordBypass();
          return { result: 'bypass', reason: 'has_authorization' };
        }
      } else {
        store.recordBypass();
        return { result: 'bypass', reason: bypassCheck.reason };
      }
    }

    // 2. Lookup in store if not already resolved
    const entry = resolvedEntry ?? store.get(key.keyHash);
    if (!entry) {
      store.recordMiss();
      return { result: 'miss', reason: 'not_found' };
    }

    // Guard against SHA-256 key collisions via exact keyString check
    if (entry.keyString !== key.keyString) {
      console.warn(
        `cache_key_collision: hash collision detected for hash=${key.keyHash} requestId=${requestId}`
      );
      store.recordMiss();
      return { result: 'miss', reason: 'not_found' };
    }

    // 3. RFC 9111 freshness & revalidation check
    const now = clock.now();
    if (!isFresh(entry, now)) {
      if (isWithinStaleWhileRevalidate(entry, now)) {
        return { result: 'stale', entry, reason: 'expired', staleWhileRevalidate: true };
      }
      const conditionals = buildUpstreamConditionals(entry);
      const revalidateEnabled = options.revalidate?.enabled ?? true;
      if (revalidateEnabled && (conditionals.hasValidators || allowsStaleServing(entry))) {
        return { result: 'stale', entry, reason: 'expired', staleWhileRevalidate: false };
      }
      store.delete(key.keyHash);
      store.recordMiss();
      return { result: 'miss', reason: 'expired' };
    }

    // 4. Cache hit
    entry.hitCount++;
    entry.lastAccessedAt = now;
    store.recordHit(key.keyHash, now);

    return {
      result: 'hit',
      entry,
    };
  } catch (err: any) {
    // Robustness rule: never fail client request on cache exception
    console.error(
      `cache_error: lookup failed, falling back to bypass requestId=${requestId} error=${err?.message ?? err}`
    );
    try {
      store.recordBypass();
    } catch {
      // ignore
    }
    return {
      result: 'bypass',
      reason: 'cache_error',
    };
  }
}
