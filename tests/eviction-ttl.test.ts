import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/cache/memory-store.js';
import { TtlEvictor, isTtlEvictable } from '../src/cache/eviction/ttl.js';
import { FakeClock } from '../src/util/clock.js';
import { CacheEntry } from '../src/cache/store.js';

function createEntry(
  keyHash: string,
  cacheControl: string,
  freshnessLifetimeMs: number,
  baseTime: number = 1000
): CacheEntry {
  const body = Buffer.from(`payload for ${keyHash}`);
  return {
    keyHash,
    keyString: `GET https://cdn.example.com/${keyHash}`,
    originId: 'origin-1',
    status: 200,
    statusMessage: 'OK',
    headers: {
      'content-type': 'text/plain',
      'cache-control': cacheControl,
    },
    body,
    size: body.byteLength,
    storedAt: baseTime,
    lastAccessedAt: baseTime,
    hitCount: 0,
    requestTimeMs: baseTime - 10,
    responseTimeMs: baseTime,
    dateValueMs: baseTime,
    ageValueSeconds: 0,
    freshnessLifetimeMs,
    lifetimeSource: 'max-age',
  };
}

describe('Feature 34: TTL eviction', () => {
  it('does not evict fresh entries', () => {
    const baseTime = 10000;
    const clock = new FakeClock(baseTime);
    const store = new MemoryStore();
    const evictor = new TtlEvictor(store, clock);

    // Fresh entry: lifetime 60s (expires at 70000)
    const freshEntry = createEntry('fresh-1', 'max-age=60', 60000, baseTime);
    store.set(freshEntry);

    // Clock advances 30s (t=40000), still fresh
    clock.advance(30000);
    expect(isTtlEvictable(freshEntry, clock.now())).toBe(false);

    const result = evictor.evictExpired();
    expect(result.evictedCount).toBe(0);
    expect(store.get('fresh-1')).toBeDefined();
  });

  it('evicts expired entries past all freshness and stale windows', () => {
    const baseTime = 10000;
    const clock = new FakeClock(baseTime);
    const store = new MemoryStore();
    const evictor = new TtlEvictor(store, clock);

    // Entry with 60s freshness and no stale window
    const entry = createEntry('exp-plain', 'max-age=60', 60000, baseTime);
    store.set(entry);

    // Advance 61 seconds (past 60s freshness)
    clock.advance(61000);
    expect(isTtlEvictable(entry, clock.now())).toBe(true);

    const result = evictor.evictExpired();
    expect(result.evictedCount).toBe(1);
    expect(result.evictedKeys).toContain('exp-plain');
    expect(store.get('exp-plain')).toBeUndefined();
    expect(store.stats().entries).toBe(0);
    expect(store.stats().totalBytes).toBe(0);
  });

  it('CRITICAL: stale entry inside stale-while-revalidate window is NOT evicted', () => {
    const baseTime = 10000;
    const clock = new FakeClock(baseTime);
    const store = new MemoryStore();
    const evictor = new TtlEvictor(store, clock);

    // Lifetime: 60s, stale-while-revalidate: 30s (servable until 10000 + 60000 + 30000 = 100000)
    const swrEntry = createEntry('swr-item', 'max-age=60, stale-while-revalidate=30', 60000, baseTime);
    store.set(swrEntry);

    // Advance to 75 seconds (stale, but inside the 30s SWR window)
    clock.set(baseTime + 75000);
    expect(isTtlEvictable(swrEntry, clock.now())).toBe(false);

    let result = evictor.evictExpired();
    expect(result.evictedCount).toBe(0);
    expect(store.get('swr-item')).toBeDefined(); // Kept in cache!

    // Advance to 95 seconds (past the 30s SWR window)
    clock.set(baseTime + 95000);
    expect(isTtlEvictable(swrEntry, clock.now())).toBe(true);

    result = evictor.evictExpired();
    expect(result.evictedCount).toBe(1);
    expect(result.evictedKeys).toContain('swr-item');
    expect(store.get('swr-item')).toBeUndefined(); // Evicted!
  });

  it('CRITICAL: stale entry inside stale-if-error window is NOT evicted', () => {
    const baseTime = 10000;
    const clock = new FakeClock(baseTime);
    const store = new MemoryStore();
    const evictor = new TtlEvictor(store, clock);

    // Lifetime: 60s, stale-if-error: 45s (servable until 10000 + 60000 + 45000 = 115000)
    const sieEntry = createEntry('sie-item', 'max-age=60, stale-if-error=45', 60000, baseTime);
    store.set(sieEntry);

    // Advance to 80 seconds (stale, but within 45s SIE window)
    clock.set(baseTime + 80000);
    expect(isTtlEvictable(sieEntry, clock.now())).toBe(false);

    let result = evictor.evictExpired();
    expect(result.evictedCount).toBe(0);
    expect(store.get('sie-item')).toBeDefined(); // Protected from eviction!

    // Advance past SIE window (110 seconds)
    clock.set(baseTime + 110000);
    expect(isTtlEvictable(sieEntry, clock.now())).toBe(true);

    result = evictor.evictExpired();
    expect(result.evictedCount).toBe(1);
    expect(store.get('sie-item')).toBeUndefined();
  });

  it('must-revalidate entries follow Batch 8 rules and are evicted once expired', () => {
    const baseTime = 10000;
    const clock = new FakeClock(baseTime);
    const store = new MemoryStore();
    const evictor = new TtlEvictor(store, clock);

    // must-revalidate with stale-while-revalidate: Batch 8 rules forbid stale serving
    const mrEntry = createEntry('must-reval-item', 'max-age=60, must-revalidate, stale-while-revalidate=60', 60000, baseTime);
    store.set(mrEntry);

    // While fresh (30s), not evictable
    clock.set(baseTime + 30000);
    expect(isTtlEvictable(mrEntry, clock.now())).toBe(false);

    // Once expired (65s), cannot be served stale per Batch 8 RFC 9111 rules -> evictable
    clock.set(baseTime + 65000);
    expect(isTtlEvictable(mrEntry, clock.now())).toBe(true);

    const result = evictor.evictExpired();
    expect(result.evictedCount).toBe(1);
    expect(store.get('must-reval-item')).toBeUndefined();
  });

  it('integrates evictExpired directly on MemoryStore', () => {
    const clock = new FakeClock(1000);
    const store = new MemoryStore();

    const e1 = createEntry('k1', 'max-age=10', 10000, 1000);
    const e2 = createEntry('k2', 'max-age=100', 100000, 1000);
    store.set(e1);
    store.set(e2);

    clock.advance(20000); // t=21000, k1 expired, k2 fresh
    const evicted = store.evictExpired(clock.now());
    expect(evicted.evictedCount).toBe(1);
    expect(evicted.evictedKeys).toEqual(['k1']);
    expect(store.get('k1')).toBeUndefined();
    expect(store.get('k2')).toBeDefined();
  });
});
