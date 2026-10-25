import { describe, it, expect } from 'vitest';
import { MetadataIndex, EntryMetadata } from '../src/cache/metadata-index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { lookupCache } from '../src/cache/lookup.js';
import { FakeClock } from '../src/util/clock.js';
import { generateCacheKey } from '../src/cache/key.js';

function createSampleMetadata(overrides: Partial<EntryMetadata> = {}): EntryMetadata {
  return {
    keyHash: 'hash-meta-1',
    keyString: 'GET https://cdn.example.com/item/1',
    originId: 'origin-alpha',
    namespace: 'default',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' },
    size: 256,
    storedAt: 1000,
    lastAccessedAt: 1000,
    hitCount: 0,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 120000,
    lifetimeSource: 'max-age',
    ...overrides,
  };
}

function createSampleCacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const body = overrides.body ?? Buffer.from('{"id":1,"status":"active"}');
  return {
    keyHash: 'hash-entry-1',
    keyString: 'GET https://cdn.example.com/item/1',
    originId: 'origin-alpha',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' },
    body,
    size: body.byteLength,
    storedAt: 1000,
    lastAccessedAt: 1000,
    hitCount: 0,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 120000,
    lifetimeSource: 'max-age',
    ...overrides,
  };
}

describe('Feature 30: Metadata index', () => {
  describe('O(1) lookup and data structure assertion', () => {
    it('uses a Map for O(1) hash map lookup without linear scans', () => {
      const index = new MetadataIndex();
      expect(index.getUnderlyingMap()).toBeInstanceOf(Map);

      // Populate 1,000 entries
      for (let i = 0; i < 1000; i++) {
        index.set(createSampleMetadata({
          keyHash: `hash-${i}`,
          keyString: `GET https://cdn.example.com/items/${i}`,
          size: i,
        }));
      }

      expect(index.size).toBe(1000);

      // Verify direct O(1) retrieval
      const start = performance.now();
      const meta500 = index.get('hash-500');
      const duration = performance.now() - start;

      expect(meta500).toBeDefined();
      expect(meta500?.keyHash).toBe('hash-500');
      expect(meta500?.size).toBe(500);
      expect(duration).toBeLessThan(5); // O(1) Map lookup is sub-millisecond
    });

    it('indexes key -> metadata with all required freshness, lifecycle, and namespace fields', () => {
      const index = new MetadataIndex();
      const meta = createSampleMetadata({
        keyHash: 'hash-full-spec',
        originId: 'origin-1',
        namespace: 'tenant-a',
        status: 200,
        headers: { 'cache-control': 'max-age=300', etag: '"v1.0"' },
        size: 1024,
        storedAt: 5000,
        lastAccessedAt: 5000,
        hitCount: 0,
      });

      index.set(meta);

      const retrieved = index.get('hash-full-spec');
      expect(retrieved).toBeDefined();
      expect(retrieved?.keyHash).toBe('hash-full-spec');
      expect(retrieved?.namespace).toBe('tenant-a');
      expect(retrieved?.size).toBe(1024);
      expect(retrieved?.status).toBe(200);
      expect(retrieved?.storedAt).toBe(5000);
      expect(retrieved?.lastAccessedAt).toBe(5000);
      expect(retrieved?.hitCount).toBe(0);
      expect(retrieved?.headers['cache-control']).toBe('max-age=300');
    });
  });

  describe('Metadata update on every hit', () => {
    it('updates last-access and hit count on recordHit without scanning', () => {
      const index = new MetadataIndex();
      const meta = createSampleMetadata({ keyHash: 'hash-hit-test', hitCount: 0, lastAccessedAt: 1000 });
      index.set(meta);

      const updated1 = index.recordHit('hash-hit-test', 2500);
      expect(updated1).toBeDefined();
      expect(updated1?.hitCount).toBe(1);
      expect(updated1?.lastAccessedAt).toBe(2500);

      const updated2 = index.recordHit('hash-hit-test', 3200);
      expect(updated2?.hitCount).toBe(2);
      expect(updated2?.lastAccessedAt).toBe(3200);

      // Verify persistent in index
      const fetched = index.get('hash-hit-test');
      expect(fetched?.hitCount).toBe(2);
      expect(fetched?.lastAccessedAt).toBe(3200);
    });

    it('returns undefined when recordHit is called on non-existent key', () => {
      const index = new MetadataIndex();
      expect(index.recordHit('missing-hash', 2000)).toBeUndefined();
    });
  });

  describe('Atomic lifecycle: delete removes metadata and body together with zero orphans', () => {
    it('removes metadata and body together on delete, leaving no orphans', () => {
      const store = new MemoryStore();
      const entry = createSampleCacheEntry({
        keyHash: 'hash-orphan-test',
        body: Buffer.from('hello orphan check'),
      });

      expect(store.set(entry)).toBe(true);
      expect(store.getMetadataIndex().has('hash-orphan-test')).toBe(true);
      expect(store.get('hash-orphan-test')).toBeDefined();
      expect(store.stats().totalBytes).toBe(entry.size);

      // Delete removes both metadata and body
      const deleted = store.delete('hash-orphan-test');
      expect(deleted).toBe(true);

      // Assert zero orphans in either direction
      expect(store.getMetadataIndex().has('hash-orphan-test')).toBe(false);
      expect(store.getMetadataIndex().get('hash-orphan-test')).toBeUndefined();
      expect(store.get('hash-orphan-test')).toBeUndefined();
      expect(store.stats().totalBytes).toBe(0);
      expect(store.stats().entries).toBe(0);
    });

    it('updates metadata on cache hit through proxy lookup path', () => {
      const store = new MemoryStore();
      const clock = new FakeClock(1000);
      const cacheKey = generateCacheKey({
        originId: 'origin-alpha',
        method: 'GET',
        host: 'example.com',
        normalizedPath: '/test',
        normalizedQuery: '',
      });
      const entry = createSampleCacheEntry({
        keyHash: cacheKey.keyHash,
        keyString: cacheKey.keyString,
        storedAt: 1000,
        lastAccessedAt: 1000,
        hitCount: 0,
      });

      store.set(entry);

      const req = { method: 'GET', headers: {} };

      clock.advance(500); // clock is at 1500
      const lookupResult = lookupCache(req, cacheKey, store, clock);
      expect(lookupResult.result).toBe('hit');

      // Assert that store metadata index was updated on hit
      const meta = store.getMetadataIndex().get(cacheKey.keyHash);
      expect(meta).toBeDefined();
      expect(meta?.hitCount).toBe(1);
      expect(meta?.lastAccessedAt).toBe(1500);

      // Second hit
      clock.advance(1000); // clock is at 2500
      lookupCache(req, cacheKey, store, clock);
      const meta2 = store.getMetadataIndex().get(cacheKey.keyHash);
      expect(meta2?.hitCount).toBe(2);
      expect(meta2?.lastAccessedAt).toBe(2500);
    });
  });
});
