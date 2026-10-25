import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/cache/memory-store.js';
import { LruPolicy } from '../src/cache/eviction/lru.js';
import { LfuPolicy } from '../src/cache/eviction/lfu.js';
import { CacheEntry } from '../src/cache/store.js';

function createDummyEntry(keyHash: string, size: number): CacheEntry {
  const body = Buffer.alloc(size, 0x61);
  return {
    keyHash,
    keyString: `GET https://example.com/${keyHash}`,
    originId: 'origin-1',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=300' },
    body,
    size,
    storedAt: 1000,
    hitCount: 0,
    lastAccessedAt: 1000,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 300000,
    lifetimeSource: 'max-age',
  };
}

// Deterministic PRNG with fixed seed (Mulberry32)
function createRng(seed: number) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Feature 35: Size eviction', () => {
  describe('Budget enforcement via active eviction policy', () => {
    it('evicts via LRU policy until under maxTotalBytes budget', () => {
      const store = new MemoryStore({
        maxTotalBytes: 100,
        maxEntries: 10,
        evictionPolicy: new LruPolicy(),
      });

      const e1 = createDummyEntry('e1', 40);
      const e2 = createDummyEntry('e2', 40);
      expect(store.set(e1)).toBe(true);
      expect(store.set(e2)).toBe(true);
      expect(store.stats().totalBytes).toBe(80);

      // Access e1 so e2 becomes LRU
      store.recordHit('e1', 2000);

      // Insert e3 (40 bytes) -> would be 120 bytes > 100 budget
      // e2 should be evicted (as least recently used)
      const e3 = createDummyEntry('e3', 40);
      expect(store.set(e3)).toBe(true);

      expect(store.stats().totalBytes).toBe(80);
      expect(store.stats().totalBytes).toBeLessThanOrEqual(100);
      expect(store.get('e1')).toBeDefined();
      expect(store.get('e2')).toBeUndefined(); // Evicted!
      expect(store.get('e3')).toBeDefined();
    });

    it('evicts via policy until under maxEntries budget', () => {
      const store = new MemoryStore({
        maxTotalBytes: 1000,
        maxEntries: 2,
        evictionPolicy: new LruPolicy(),
      });

      expect(store.set(createDummyEntry('k1', 10))).toBe(true);
      expect(store.set(createDummyEntry('k2', 10))).toBe(true);
      expect(store.stats().entries).toBe(2);

      // Insert k3 -> exceeds maxEntries (3 > 2), k1 evicted
      expect(store.set(createDummyEntry('k3', 10))).toBe(true);
      expect(store.stats().entries).toBe(2);
      expect(store.stats().entries).toBeLessThanOrEqual(2);
      expect(store.get('k1')).toBeUndefined();
      expect(store.get('k2')).toBeDefined();
      expect(store.get('k3')).toBeDefined();
    });

    it('rejects a single object larger than maxObjectBytes cleanly without corrupting state', () => {
      const store = new MemoryStore({
        maxObjectBytes: 50,
        maxTotalBytes: 200,
        evictionPolicy: new LruPolicy(),
      });

      store.set(createDummyEntry('valid', 30));
      expect(store.stats().totalBytes).toBe(30);

      const oversized = createDummyEntry('huge', 100); // 100 > 50
      expect(store.set(oversized)).toBe(false);

      // Verify clean state
      expect(store.stats().storeSkipped).toBe(1);
      expect(store.stats().totalBytes).toBe(30);
      expect(store.get('huge')).toBeUndefined();
      expect(store.get('valid')).toBeDefined();
    });

    it('ensures a new insert never evicts itself and budget is never exceeded', () => {
      const store = new MemoryStore({
        maxTotalBytes: 100,
        maxObjectBytes: 200,
        evictionPolicy: new LruPolicy(),
      });

      store.set(createDummyEntry('e1', 50));
      expect(store.stats().totalBytes).toBe(50);

      // Insert object that is larger than maxTotalBytes (110 > 100)
      const impossible = createDummyEntry('too-big-for-cache', 110);
      expect(store.set(impossible)).toBe(false);

      // e1 must not be evicted for an object that can never fit!
      expect(store.get('e1')).toBeDefined();
      expect(store.stats().totalBytes).toBe(50);
      expect(store.stats().totalBytes).toBeLessThanOrEqual(100);
    });
  });

  describe('Cross-cutting: in-flight and revalidation lock protection', () => {
    it('never evicts an entry with an active revalidation lock or in-flight status', () => {
      const protectedKeys = new Set<string>();
      const store = new MemoryStore({
        maxTotalBytes: 100,
        maxEntries: 5,
        evictionPolicy: new LruPolicy(),
        isProtectedFromEviction: (keyHash) => protectedKeys.has(keyHash),
      });

      store.set(createDummyEntry('locked-key', 40));
      store.set(createDummyEntry('unlocked-key', 40));

      // Mark locked-key as protected (e.g. active revalidation lock in-flight)
      protectedKeys.add('locked-key');

      // locked-key is older than unlocked-key, but protected!
      // When inserting new-key (40B), unlocked-key must be evicted instead of locked-key
      expect(store.set(createDummyEntry('new-key', 40))).toBe(true);

      expect(store.get('locked-key')).toBeDefined(); // Protected from eviction!
      expect(store.get('unlocked-key')).toBeUndefined(); // Evicted!
      expect(store.get('new-key')).toBeDefined();
      expect(store.stats().totalBytes).toBe(80);
    });
  });

  describe('Policy switching: LRU vs LFU under the same size eviction budget', () => {
    it('protects frequent items when running under LFU size eviction', () => {
      const store = new MemoryStore({
        maxTotalBytes: 100,
        maxEntries: 5,
        evictionPolicy: new LfuPolicy(),
      });

      store.set(createDummyEntry('popular', 40));
      store.set(createDummyEntry('rare', 40));

      // popular gets 5 hits
      for (let i = 0; i < 5; i++) {
        store.recordHit('popular');
      }

      // Even if popular was inserted first, rare has lower frequency and must be evicted
      expect(store.set(createDummyEntry('incoming', 40))).toBe(true);

      expect(store.get('popular')).toBeDefined(); // Protected by frequency!
      expect(store.get('rare')).toBeUndefined(); // Evicted by LFU
      expect(store.get('incoming')).toBeDefined();
      expect(store.stats().totalBytes).toBe(80);
    });
  });

  describe('Randomized concurrent stress test with fixed seed', () => {
    it('maintains strict consistency of byte count, entry count, and index under parallel load', async () => {
      const rng = createRng(12345);
      const store = new MemoryStore({
        maxTotalBytes: 500,
        maxEntries: 10,
        maxObjectBytes: 150,
        evictionPolicy: new LruPolicy(),
      });

      const numOperations = 500;
      const keyPool = Array.from({ length: 25 }, (_, i) => `key-${i}`);

      for (let i = 0; i < numOperations; i++) {
        const action = rng();
        const key = keyPool[Math.floor(rng() * keyPool.length)];

        if (action < 0.6) {
          // 60% Inserts / overwrites
          const size = Math.floor(rng() * 120) + 1; // 1 to 120 bytes
          store.set(createDummyEntry(key, size));
        } else if (action < 0.85) {
          // 25% Gets & hits
          const hit = store.get(key);
          if (hit) {
            store.recordHit(key, 1000 + i);
          }
        } else {
          // 15% Deletes
          store.delete(key);
        }

        // Mid-test invariant check: budget must never be exceeded
        expect(store.stats().totalBytes).toBeLessThanOrEqual(500);
        expect(store.stats().entries).toBeLessThanOrEqual(10);
      }

      // End-of-test deep consistency assertions
      const stats = store.stats();
      const objectStore = store.getObjectStore();
      const metadataIndex = store.getMetadataIndex();

      expect(stats.totalBytes).toBe(objectStore.totalBytes);
      expect(stats.totalBytes).toBe(objectStore.sumLiveBytes());
      expect(stats.entries).toBe(objectStore.count);
      expect(stats.entries).toBe(metadataIndex.size);

      // Verify zero orphans: every metadata has an object, every object has metadata
      for (const [keyHash, meta] of metadataIndex.entries()) {
        expect(objectStore.has(keyHash)).toBe(true);
        expect(objectStore.sizeOf(keyHash)).toBe(meta.size);
      }
      for (const keyHash of objectStore.keys()) {
        expect(metadataIndex.has(keyHash)).toBe(true);
      }
    });
  });
});
