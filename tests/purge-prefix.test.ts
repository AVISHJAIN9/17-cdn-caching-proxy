import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 119: Prefix purge', () => {
  it('purges path prefix within tenant', () => {
    const index = new PurgeIndex();
    const store = new MemoryStore();
    const e = {
      keyHash: 'p1',
      keyString: 'http://example.com/static/file.js',
      originId: 'default',
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
    index.indexEntry(e, 'http://example.com/static/file.js');

    const res = index.executePurge({ type: 'prefix', target: '/static/' }, store);
    expect(res.purgedCount).toBe(1);
    expect(store.get('p1')).toBeUndefined();
  });
});
