import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 116: Tenant view', () => {
  it('enforces tenant scoping and provides isolated tenant metrics', () => {
    const store = new MemoryStore({
      tenantQuotas: {
        tenantA: { maxTotalBytes: 50000, maxEntries: 10 },
      },
    });

    store.set({
      keyHash: 'ta-1',
      keyString: 'http://example.com/item',
      originId: 'default',
      namespace: 'tenantA',
      status: 200,
      statusMessage: 'OK',
      headers: {},
      body: Buffer.from('data'),
      size: 4,
      storedAt: Date.now(),
      hitCount: 1,
      lastAccessedAt: Date.now(),
      requestTimeMs: Date.now(),
      responseTimeMs: Date.now(),
      dateValueMs: Date.now(),
      ageValueSeconds: 0,
      freshnessLifetimeMs: 1000,
      lifetimeSource: 'max-age',
    });

    const tenantStats = store.getTenantStats('tenantA');
    expect(tenantStats.entries).toBe(1);
    expect(tenantStats.totalBytes).toBe(4);
  });
});
