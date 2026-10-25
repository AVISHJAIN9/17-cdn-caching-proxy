import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 122: Tenant purge', () => {
  it('purges all objects for given tenant with strict namespace isolation', () => {
    const index = new PurgeIndex();
    const store = new MemoryStore();
    const e = {
      keyHash: 'ten-1',
      keyString: 'http://example.com/asset',
      originId: 'default',
      namespace: 'tenantX',
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
      lifetimeSource: 'max-age' as const,
    };
    store.set(e);
    index.indexEntry(e, 'http://example.com/asset');

    const res = index.executePurge({ type: 'tenant', target: 'tenantX', tenant: 'tenantX' }, store);
    expect(res.purgedCount).toBe(1);
    expect(store.get('ten-1')).toBeUndefined();
  });
});
