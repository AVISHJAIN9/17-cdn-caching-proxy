import { CacheEntry, CacheStore } from '../store.js';
import { isFresh } from '../freshness.js';
import { isWithinStaleWhileRevalidate, isWithinStaleIfError } from '../stale.js';
import { Clock } from '../../util/clock.js';

export interface TtlEvictionResult {
  evictedCount: number;
  evictedBytes: number;
  evictedKeys: string[];
}

/**
 * Checks whether an entry is eligible for TTL eviction at the specified timestamp.
 * An entry is NOT evictable if:
 * 1. It is fresh per RFC 9111.
 * 2. It is stale but within its stale-while-revalidate window (RFC 5861 Section 3).
 * 3. It is stale but within its stale-if-error window (RFC 5861 Section 4).
 * If none of the above apply (e.g. past all windows or must-revalidate expired),
 * the entry cannot be served and is evictable.
 */
export function isTtlEvictable(entry: CacheEntry, nowMs: number): boolean {
  if (isFresh(entry, nowMs)) {
    return false;
  }
  if (isWithinStaleWhileRevalidate(entry, nowMs)) {
    return false;
  }
  if (isWithinStaleIfError(entry, nowMs)) {
    return false;
  }
  return true;
}

export interface TtlEvictableStore extends CacheStore {
  getAllEntries?(): Iterable<[string, CacheEntry]>;
  evictExpired?(nowMs?: number): TtlEvictionResult;
}

import { EvictionEvent } from '../store.js';

/**
 * TtlEvictor sweeps cache entries and evicts those that can no longer be served.
 */
export class TtlEvictor {
  constructor(
    private readonly store: TtlEvictableStore,
    private readonly clock: Clock,
    private readonly onEvict?: (event: EvictionEvent) => void
  ) {}

  evictExpired(nowMs?: number): TtlEvictionResult {
    const now = nowMs ?? this.clock.now();

    if (this.store.evictExpired) {
      const res = this.store.evictExpired(now);
      if (res.evictedCount > 0) {
        this.onEvict?.({
          reason: 'ttl',
          tenant: 'default',
          count: res.evictedCount,
          bytes: res.evictedBytes,
        });
      }
      return res;
    }

    const evictedKeys: string[] = [];
    let evictedBytes = 0;

    const entriesIterable = this.store.getAllEntries?.() ?? [];
    for (const [keyHash, entry] of entriesIterable) {
      if (isTtlEvictable(entry, now)) {
        const size = entry.size;
        const tenant = (entry as any).namespace ?? 'default';
        if (this.store.delete(keyHash)) {
          evictedKeys.push(keyHash);
          evictedBytes += size;
          this.onEvict?.({
            reason: 'ttl',
            tenant,
            count: 1,
            bytes: size,
            keyHash,
          });
        }
      }
    }

    return {
      evictedCount: evictedKeys.length,
      evictedBytes,
      evictedKeys,
    };
  }
}
