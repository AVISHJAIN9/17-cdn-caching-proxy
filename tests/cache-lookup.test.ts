import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/cache/memory-store.js';
import { lookupCache } from '../src/cache/lookup.js';
import { FakeClock } from '../src/util/clock.js';
import { CacheEntry } from '../src/cache/store.js';

describe('Feature 3: Cache lookup (src/cache/lookup.ts, src/cache/memory-store.ts)', () => {
  let store: MemoryStore;
  let clock: FakeClock;

  const sampleKey = {
    keyHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    keyString: '["v1","default","default","GET","example.com","/hello",""]',
  };

  const createSampleEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
    keyHash: sampleKey.keyHash,
    keyString: sampleKey.keyString,
    originId: 'default',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'content-length': '5' },
    body: Buffer.from('hello'),
    size: 5,
    storedAt: clock.now(),
    requestTimeMs: clock.now() - 50,
    responseTimeMs: clock.now(),
    dateValueMs: clock.now(),
    ageValueSeconds: 0,
    freshnessLifetimeMs: 60000,
    lifetimeSource: 'max-age',
    hitCount: 0,
    lastAccessedAt: clock.now(),
    ...overrides,
  });

  beforeEach(() => {
    store = new MemoryStore();
    clock = new FakeClock(1000000);
  });

  describe('Bypass evaluations', () => {
    it('bypasses non-GET methods (POST, PUT, DELETE, HEAD)', () => {
      const getReq = { method: 'GET', headers: {} };
      expect(lookupCache(getReq, sampleKey, store, clock).result).toBe('miss');

      const methods = ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
      for (const m of methods) {
        const res = lookupCache({ method: m, headers: {} }, sampleKey, store, clock);
        expect(res.result).toBe('bypass');
        if (res.result === 'bypass') {
          expect(res.reason).toBe('method_not_cacheable');
        }
      }
    });

    it('bypasses when Authorization header is present', () => {
      const req = { method: 'GET', headers: { authorization: 'Bearer token-123' } };
      const res = lookupCache(req, sampleKey, store, clock);
      expect(res.result).toBe('bypass');
      if (res.result === 'bypass') expect(res.reason).toBe('has_authorization');
    });

    it('bypasses when Cookie header is present and bypassOnCookie is true', () => {
      const reqWithCookie = { method: 'GET', headers: { cookie: 'session_id=abc' } };
      const resDefault = lookupCache(reqWithCookie, sampleKey, store, clock);
      expect(resDefault.result).toBe('bypass');
      if (resDefault.result === 'bypass') expect(resDefault.reason).toBe('has_cookie');

      // Can be disabled via bypassOnCookie: false
      const resAllowed = lookupCache(reqWithCookie, sampleKey, store, clock, { bypassOnCookie: false });
      expect(resAllowed.result).toBe('miss');
    });

    it('bypasses when Range header is present', () => {
      const req = { method: 'GET', headers: { range: 'bytes=0-100' } };
      const res = lookupCache(req, sampleKey, store, clock);
      expect(res.result).toBe('bypass');
      if (res.result === 'bypass') expect(res.reason).toBe('has_range');
    });

    it('bypasses when conditional request headers are present (if-match, if-unmodified-since, if-range)', () => {
      const conditionalHeaders = [
        { 'if-match': '"etag-1"' },
        { 'if-unmodified-since': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        { 'if-range': '"etag-1"' },
      ];

      for (const h of conditionalHeaders) {
        const res = lookupCache({ method: 'GET', headers: h }, sampleKey, store, clock);
        expect(res.result).toBe('bypass');
        if (res.result === 'bypass') expect(res.reason).toBe('conditional_request');
      }
    });

    it('bypasses when Cache-Control or Pragma has no-cache or no-store (token-level parsing)', () => {
      const noStoreReq = { method: 'GET', headers: { 'cache-control': 'public, max-age=0, no-store' } };
      const res1 = lookupCache(noStoreReq, sampleKey, store, clock);
      expect(res1.result).toBe('bypass');
      if (res1.result === 'bypass') expect(res1.reason).toBe('client_no_store');

      const noCacheReq = { method: 'GET', headers: { pragma: 'no-cache' } };
      const res2 = lookupCache(noCacheReq, sampleKey, store, clock);
      expect(res2.result).toBe('bypass');
      if (res2.result === 'bypass') expect(res2.reason).toBe('client_no_cache');

      // Substring check guard: "no-cache-foo" should NOT trigger no-cache
      const harmlessReq = { method: 'GET', headers: { 'cache-control': 'no-cache-foo' } };
      const res3 = lookupCache(harmlessReq, sampleKey, store, clock);
      expect(res3.result).toBe('miss');
    });

    it('bypasses when cache is disabled via config', () => {
      const req = { method: 'GET', headers: {} };
      const res = lookupCache(req, sampleKey, store, clock, { enabled: false });
      expect(res.result).toBe('bypass');
      if (res.result === 'bypass') expect(res.reason).toBe('cache_disabled');
    });
  });

  describe('Miss, Expiration & Collision', () => {
    it('returns miss with not_found when store is empty', () => {
      const res = lookupCache({ method: 'GET', headers: {} }, sampleKey, store, clock);
      expect(res.result).toBe('miss');
      if (res.result === 'miss') expect(res.reason).toBe('not_found');
    });

    it('returns miss with expired when entry is past TTL and lazily deletes it', () => {
      const entry = createSampleEntry({ freshnessLifetimeMs: 1000 });
      store.set(entry);
      expect(store.stats().entries).toBe(1);

      // Advance clock past expiration
      clock.advance(1001);

      const res = lookupCache({ method: 'GET', headers: {} }, sampleKey, store, clock);
      expect(res.result).toBe('miss');
      if (res.result === 'miss') expect(res.reason).toBe('expired');

      // Entry should now be deleted from store
      expect(store.stats().entries).toBe(0);
      expect(store.get(sampleKey.keyHash)).toBeUndefined();
    });

    it('guards against SHA-256 collision: matching hash with different keyString treats as miss', () => {
      const storedEntry = createSampleEntry({
        keyHash: sampleKey.keyHash,
        keyString: '["v1","default","default","GET","example.com","/hello",""]',
      });
      store.set(storedEntry);

      // Same hash but different keyString
      const collidingKey = {
        keyHash: sampleKey.keyHash,
        keyString: '["v1","default","default","GET","colliding.com","/different",""]',
      };

      const res = lookupCache({ method: 'GET', headers: {} }, collidingKey, store, clock);
      expect(res.result).toBe('miss');
      if (res.result === 'miss') expect(res.reason).toBe('not_found');
    });
  });

  describe('Cache Hit & Immutability', () => {
    it('returns hit with entry, updating hitCount and lastAccessedAt', () => {
      const entry = createSampleEntry();
      store.set(entry);

      clock.advance(500);
      const res = lookupCache({ method: 'GET', headers: {} }, sampleKey, store, clock);
      expect(res.result).toBe('hit');
      if (res.result === 'hit') {
        expect(res.entry.hitCount).toBe(1);
        expect(res.entry.lastAccessedAt).toBe(clock.now());
        expect(res.entry.body.toString()).toBe('hello');
      }

      const stats = store.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(0);
    });

    it('guarantees entry immutability: modifying retrieved entry does not alter store', () => {
      const entry = createSampleEntry();
      store.set(entry);

      const retrieved1 = store.get(sampleKey.keyHash)!;
      retrieved1.headers['x-added'] = 'mutated';
      retrieved1.body[0] = 0x58; // 'X'

      const retrieved2 = store.get(sampleKey.keyHash)!;
      expect(retrieved2.headers['x-added']).toBeUndefined();
      expect(retrieved2.body.toString()).toBe('hello');
    });
  });

  describe('MemoryStore limits & stats arithmetic', () => {
    it('tracks totalBytes accurately matching real sum of stored body sizes', () => {
      const storeWithLimits = new MemoryStore({ maxTotalBytes: 1000, maxEntries: 10 });

      const e1 = createSampleEntry({ keyHash: 'hash-1', size: 100, body: Buffer.alloc(100) });
      const e2 = createSampleEntry({ keyHash: 'hash-2', size: 250, body: Buffer.alloc(250) });
      storeWithLimits.set(e1);
      storeWithLimits.set(e2);

      expect(storeWithLimits.stats().totalBytes).toBe(350);
      expect(storeWithLimits.stats().entries).toBe(2);

      storeWithLimits.delete('hash-1');
      expect(storeWithLimits.stats().totalBytes).toBe(250);
      expect(storeWithLimits.stats().entries).toBe(1);
    });

    it('refuses to store and logs cache_full when maxTotalBytes or maxEntries is reached without evicting', () => {
      const tinyStore = new MemoryStore({ maxTotalBytes: 50, maxEntries: 2 });

      const e1 = createSampleEntry({ keyHash: 'h1', size: 20, body: Buffer.alloc(20) });
      const e2 = createSampleEntry({ keyHash: 'h2', size: 20, body: Buffer.alloc(20) });
      const e3 = createSampleEntry({ keyHash: 'h3', size: 20, body: Buffer.alloc(20) }); // Exceeds maxTotalBytes (60 > 50) and maxEntries (3 > 2)

      expect(tinyStore.set(e1)).toBe(true);
      expect(tinyStore.set(e2)).toBe(true);
      expect(tinyStore.set(e3)).toBe(false); // Refused!

      // Assert no eviction occurred
      expect(tinyStore.stats().entries).toBe(2);
      expect(tinyStore.stats().storeSkipped).toBe(1);
      expect(tinyStore.get('h1')).toBeDefined();
      expect(tinyStore.get('h2')).toBeDefined();
      expect(tinyStore.get('h3')).toBeUndefined();
    });

    it('refuses to store object exceeding maxObjectBytes', () => {
      const storeWithSmallObj = new MemoryStore({ maxObjectBytes: 10 });
      const bigEntry = createSampleEntry({ keyHash: 'big', size: 20, body: Buffer.alloc(20) });

      expect(storeWithSmallObj.set(bigEntry)).toBe(false);
      expect(storeWithSmallObj.stats().storeSkipped).toBe(1);
      expect(storeWithSmallObj.get('big')).toBeUndefined();
    });
  });

  describe('Robustness rule: store errors fall back to bypass without failing request', () => {
    it('catches store exceptions and returns bypass with cache_error', () => {
      const faultyStore: any = {
        get: () => {
          throw new Error('Database connection exploded');
        },
        recordBypass: () => {},
      };

      const res = lookupCache({ method: 'GET', headers: {} }, sampleKey, faultyStore, clock, {
        requestId: 'req-faulty',
      });

      expect(res.result).toBe('bypass');
      if (res.result === 'bypass') {
        expect(res.reason).toBe('cache_error');
      }
    });
  });
});
