import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 121: Host purge', () => {
  it('purges all objects for given host within tenant', () => {
    const index = new PurgeIndex();
    const store = new MemoryStore();
    const e = {
      keyHash: 'h1',
      keyString: 'http://cdn.example.com/asset',
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
    index.indexEntry(e, 'http://cdn.example.com/asset');

    const res = index.executePurge({ type: 'host', target: 'cdn.example.com' }, store);
    expect(res.purgedCount).toBe(1);
    expect(store.get('h1')).toBeUndefined();
  });
});
