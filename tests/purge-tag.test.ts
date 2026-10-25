import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 120: Tag purge', () => {
  it('purges by Cache-Tag / Surrogate-Key', () => {
    const index = new PurgeIndex();
    const store = new MemoryStore();
    const e = {
      keyHash: 't1',
      keyString: 'http://example.com/item',
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
    index.indexEntry(e, 'http://example.com/item', 'product-tag');

    const res = index.executePurge({ type: 'tag', target: 'product-tag' }, store);
    expect(res.purgedCount).toBe(1);
    expect(store.get('t1')).toBeUndefined();
  });
});
