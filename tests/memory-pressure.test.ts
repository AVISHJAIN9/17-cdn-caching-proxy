import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 136: Memory pressure testing', () => {
  it('enforces memory ceilings under heavy key insertion without unbounded heap growth', () => {
    // 50 KB total limit
    const store = new MemoryStore({
      maxTotalBytes: 50 * 1024,
      evictionPolicy: 'lru',
    });

    for (let i = 0; i < 200; i++) {
      store.set({
        keyHash: `press-${i}`,
        keyString: `http://example.com/${i}`,
        originId: 'default',
        status: 200,
        statusMessage: 'OK',
        headers: {},
        body: Buffer.alloc(1024, 0x41), // 1 KB
        size: 1024,
        storedAt: Date.now(),
        hitCount: 1,
        lastAccessedAt: Date.now(),
        requestTimeMs: Date.now(),
        responseTimeMs: Date.now(),
        dateValueMs: Date.now(),
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        lifetimeSource: 'max-age',
      });
    }

    const stats = store.stats();
    // Memory ceiling of 50 KB must never be exceeded
    expect(stats.totalBytes).toBeLessThanOrEqual(50 * 1024);
  });
});
