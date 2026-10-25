import { describe, it, expect, beforeEach } from 'vitest';
import { RefreshAheadManager } from '../src/cache/refresh-ahead.js';
import { FakeClock } from '../src/util/clock.js';
import { CacheEntry } from '../src/cache/store.js';

describe('Feature 147: Refresh-Ahead', () => {
  let clock: FakeClock;
  let manager: RefreshAheadManager;

  const createDummyEntry = (storedAt: number, ttlMs: number): CacheEntry => ({
    keyHash: 'hash-1',
    keyString: 'http://example.com/item',
    originId: 'default',
    status: 200,
    statusMessage: 'OK',
    headers: { 'cache-control': 'public, max-age=100' },
    body: Buffer.from('hello fresh'),
    size: 11,
    storedAt,
    hitCount: 1,
    lastAccessedAt: storedAt,
    requestTimeMs: storedAt - 10,
    responseTimeMs: storedAt,
    dateValueMs: storedAt,
    ageValueSeconds: 0,
    freshnessLifetimeMs: ttlMs,
    lifetimeSource: 'max-age',
  });

  beforeEach(() => {
    clock = new FakeClock(1000);
    manager = new RefreshAheadManager({
      clock,
      minHits: 3,
      refreshFactor: 0.2, // Refresh when remaining TTL < 20%
      maxConcurrentRefreshes: 2,
    });
  });

  it('triggers proactive refresh for hot key before expiry with zero client misses', async () => {
    const ttl = 10000; // 10s TTL
    const entry = createDummyEntry(1000, ttl);
    const key = 'hot-product-123';

    // 1st hit (at t=1000) -> cold (hit 1 < 3)
    let triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => true,
    });
    expect(triggered).toBe(false);

    // 2nd hit
    triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => true,
    });
    expect(triggered).toBe(false);

    // Advance clock to t=8500 (85% of TTL elapsed -> 15% remaining < 20% threshold)
    clock.set(9200);

    // 3rd hit (now hits=3 and remaining ratio = 1500/10000 = 0.15 < 0.2)
    let revalidateCalled = false;
    triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => {
        revalidateCalled = true;
        return true;
      },
    });

    expect(triggered).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(revalidateCalled).toBe(true);
    expect(manager.getStats().refreshesCompleted).toBe(1);
  });

  it('never triggers refresh for cold keys', () => {
    const entry = createDummyEntry(1000, 10000);
    clock.set(9000); // 90% elapsed

    const key = 'cold-key';
    const triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => true,
    });

    // Only 1 hit -> cold
    expect(triggered).toBe(false);
    expect(manager.getStats().refreshesTriggered).toBe(0);
  });

  it('skips refresh when origin circuit breaker is open', () => {
    const entry = createDummyEntry(1000, 10000);
    clock.set(9200);

    const key = 'circuit-test-key';
    manager.recordHit(key);
    manager.recordHit(key); // Hits = 2

    const triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => true,
      isCircuitOpen: () => true, // Circuit open!
    });

    expect(triggered).toBe(false);
    expect(manager.getStats().refreshesSkippedCircuit).toBe(1);
  });

  it('respects concurrency cap on simultaneous refreshes', () => {
    const entry = createDummyEntry(1000, 10000);
    clock.set(9200);

    // Prepare 3 hot keys
    for (const k of ['k1', 'k2', 'k3']) {
      manager.recordHit(k);
      manager.recordHit(k);
    }

    // Never resolve promises to simulate hanging in-flight refreshes
    const hangFn = () => new Promise<boolean>(() => {});

    expect(manager.maybeTriggerRefresh({ key: 'k1', entry, revalidateFn: hangFn })).toBe(true);
    expect(manager.maybeTriggerRefresh({ key: 'k2', entry, revalidateFn: hangFn })).toBe(true);

    // 3rd refresh exceeds maxConcurrentRefreshes=2
    expect(manager.maybeTriggerRefresh({ key: 'k3', entry, revalidateFn: hangFn })).toBe(false);
    expect(manager.getStats().refreshesSkippedCapacity).toBe(1);
  });

  it('preserves existing object when revalidation fails', async () => {
    const entry = createDummyEntry(1000, 10000);
    clock.set(9200);

    const key = 'fail-reval';
    manager.recordHit(key);
    manager.recordHit(key);

    const triggered = manager.maybeTriggerRefresh({
      key,
      entry,
      revalidateFn: async () => false, // Failure
    });

    expect(triggered).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getStats().refreshesFailed).toBe(1);
    expect(manager.getInFlightCount()).toBe(0);
  });
});
