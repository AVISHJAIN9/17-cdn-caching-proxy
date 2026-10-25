import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnsCache } from '../src/dns/cache.js';
import { FakeClock } from '../src/util/clock.js';

describe('Feature 64: DNS refresh', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
  });

  it('runs a background refresh before expiry without blocking the requesting caller', async () => {
    let resolverCallCount = 0;
    let resolvePending!: () => void;
    const resolverPromise = new Promise<void>((r) => {
      resolvePending = r;
    });

    const resolver = vi.fn(async (hostname: string) => {
      resolverCallCount++;
      if (resolverCallCount > 1) {
        // Second call (background refresh): delay until resolvePending is called
        await resolverPromise;
        return { address: '1.2.3.5', family: 4 };
      }
      return { address: '1.2.3.4', family: 4 };
    });

    const dnsCache = new DnsCache({
      ttlMs: 10_000, // 10s TTL
      refreshAheadMs: 3_000, // Refresh when 3s remain before expiry
      clock,
      resolver,
    });

    // 1. Initial resolution (t = 1_000_000)
    const first = await dnsCache.resolve('origin.internal');
    expect(first.address).toBe('1.2.3.4');
    expect(resolverCallCount).toBe(1);

    // 2. Advance clock to t = 1_008_000 (2s remaining before 10s TTL expires)
    // Within the 3s refreshAheadMs window!
    clock.advance(8_000);

    // 3. Requesting caller must NOT be blocked! It must immediately receive the cached address
    const second = await dnsCache.resolve('origin.internal');
    expect(second.address).toBe('1.2.3.4');

    // But resolver should have been triggered in background!
    expect(resolverCallCount).toBe(2);

    // Complete background resolver call
    resolvePending();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Subsequent resolution now receives the newly refreshed address
    const third = await dnsCache.resolve('origin.internal');
    expect(third.address).toBe('1.2.3.5');

    dnsCache.destroy();
  });

  it('coalesces 100 concurrent requests during a refresh so exactly 1 resolver call occurs', async () => {
    let resolverCallCount = 0;
    let resolveResolver!: () => void;
    const resolverGate = new Promise<void>((r) => {
      resolveResolver = r;
    });

    const resolver = vi.fn(async () => {
      resolverCallCount++;
      if (resolverCallCount > 1) {
        await resolverGate;
        return { address: '9.9.9.9', family: 4 };
      }
      return { address: '1.1.1.1', family: 4 };
    });

    const dnsCache = new DnsCache({
      ttlMs: 10_000,
      refreshAheadMs: 4_000,
      clock,
      resolver,
    });

    // Initial lookup
    await dnsCache.resolve('coalesce.test');
    expect(resolverCallCount).toBe(1);

    // Advance clock into refresh window
    clock.advance(7_000);

    // Launch 100 concurrent requests
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(dnsCache.resolve('coalesce.test'));
    }

    const results = await Promise.all(promises);

    // All 100 requests returned immediately with current cached address without blocking
    for (const r of results) {
      expect(r.address).toBe('1.1.1.1');
    }

    // Exactly 1 background resolver call was dispatched!
    expect(resolverCallCount).toBe(2);

    resolveResolver();
    await new Promise((resolve) => setTimeout(resolve, 10));

    dnsCache.destroy();
  });

  it('serves the last good address on refresh failure for bounded time, then fails cleanly', async () => {
    let resolverCallCount = 0;
    const resolver = vi.fn(async () => {
      resolverCallCount++;
      if (resolverCallCount > 1) {
        throw new Error('Upstream DNS failure');
      }
      return { address: '10.0.0.1', family: 4 };
    });

    const dnsCache = new DnsCache({
      ttlMs: 10_000,
      refreshAheadMs: 3_000,
      staleWhileResolvingMs: 5_000, // Can serve stale for up to 5s past expiry
      clock,
      resolver,
    });

    // Initial resolution
    await dnsCache.resolve('failover.dns');
    expect(resolverCallCount).toBe(1);

    // Advance clock into refresh window (t = 8s)
    clock.advance(8_000);

    // Trigger background refresh which will fail
    await dnsCache.resolve('failover.dns');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolverCallCount).toBe(2);

    // Clock at t = 12s (2s past TTL, but inside staleWhileResolvingMs of 5s)
    clock.advance(4_000);
    const staleResult = await dnsCache.resolve('failover.dns');
    expect(staleResult.address).toBe('10.0.0.1');

    // Clock at t = 16s (6s past TTL, exceeding staleWhileResolvingMs of 5s)
    clock.advance(4_000);

    // Now it must fail cleanly!
    await expect(dnsCache.resolve('failover.dns')).rejects.toThrow('Upstream DNS failure');

    dnsCache.destroy();
  });

  it('stops all background refresh timers cleanly on destroy() without leaked timers', () => {
    const dnsCache = new DnsCache({
      ttlMs: 5_000,
      clock,
    });

    // Start proactive background refresh timer for hostname
    dnsCache.scheduleBackgroundRefresh('timer.test', 1_000);
    expect(dnsCache.hasActiveTimers()).toBe(true);

    dnsCache.destroy();
    expect(dnsCache.hasActiveTimers()).toBe(false);
  });
});
