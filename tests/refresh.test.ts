import { describe, it, expect } from 'vitest';
import { applyNotModified } from '../src/cache/refresh.js';
import { CacheEntry } from '../src/cache/store.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { parseEntityTag } from '../src/cache/etag.js';
import { formatHttpDate } from '../src/cache/http-date.js';

describe('Feature 2: 304 Handling (src/cache/refresh.ts)', () => {
  const baseTime = 1_000_000_000_000;
  const originalBody = Buffer.from('Hello, CDN world!');

  function makeBaseEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
    return {
      keyHash: 'hash123',
      keyString: 'http://example.com/foo',
      originId: 'default',
      status: 200,
      statusMessage: 'OK',
      headers: {
        'content-type': 'text/plain',
        'content-length': originalBody.length.toString(),
        'content-encoding': 'gzip',
        'cache-control': 'max-age=60',
        'date': formatHttpDate(baseTime),
        'etag': '"v1"',
        'last-modified': 'Sat, 01 Jan 2000 00:00:00 GMT',
        'via': '1.1 origin',
      },
      body: originalBody,
      size: originalBody.length,
      storedAt: baseTime,
      hitCount: 5,
      lastAccessedAt: baseTime,
      requestTimeMs: baseTime,
      responseTimeMs: baseTime + 10,
      dateValueMs: baseTime,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 60_000,
      lifetimeSource: 'max-age',
      etag: parseEntityTag('"v1"')!,
      etagRaw: '"v1"',
      lastModifiedMs: Date.parse('Sat, 01 Jan 2000 00:00:00 GMT'),
      lastModifiedRaw: 'Sat, 01 Jan 2000 00:00:00 GMT',
      version: 1,
      ...overrides,
    };
  }

  describe('Merge Table (28 test cases)', () => {
    it('1. 304 changes Cache-Control from max-age=60 to max-age=300', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=300' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['cache-control']).toBe('max-age=300');
        expect(res.entry.freshnessLifetimeMs).toBe(300_000);
      }
    });

    it('2. 304 with no Cache-Control keeps the stored one', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: {} },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['cache-control']).toBe('max-age=60');
        expect(res.entry.freshnessLifetimeMs).toBe(60_000);
      }
    });

    it('3. 304 adds Expires', () => {
      const entry = makeBaseEntry({
        headers: {
          'content-type': 'text/plain',
          'content-length': originalBody.length.toString(),
          'date': formatHttpDate(baseTime),
          'etag': '"v1"',
        },
      });
      const expiresDate = formatHttpDate(baseTime + 120_000);
      const res = applyNotModified(
        entry,
        { headers: { 'expires': expiresDate, 'date': formatHttpDate(baseTime) } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['expires']).toBe(expiresDate);
        expect(res.entry.freshnessLifetimeMs).toBe(120_000);
      }
    });

    it('4. 304 replaces ETag with an equal weak tag', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'etag': 'W/"v1"' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['etag']).toBe('W/"v1"');
        expect(res.entry.etag?.weak).toBe(true);
        expect(res.entry.etagRaw).toBe('W/"v1"');
      }
    });

    it('5. 304 with a different ETag is a mismatch', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'etag': '"other-v2"' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('mismatch');
      if (res.kind === 'mismatch') {
        expect(res.reason).toBe('etag_mismatch');
      }
    });

    it('6. 304 with two ETag lines ignores them (keeps stored)', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        {
          headers: { 'etag': ['"v1"', '"v2"'] },
          rawHeaders: ['ETag', '"v1"', 'ETag', '"v2"'],
        },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['etag']).toBe('"v1"');
      }
    });

    it('7. 304 tries to change Content-Type: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'content-type': 'application/json' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['content-type']).toBe('text/plain');
      }
    });

    it('8. 304 tries to change Content-Length: ignored (reflects stored size)', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'content-length': '9999' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['content-length']).toBe(originalBody.length.toString());
      }
    });

    it('9. 304 tries to change Content-Encoding: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'content-encoding': 'br' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['content-encoding']).toBe('gzip');
      }
    });

    it('10. 304 tries to change Set-Cookie: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'set-cookie': 'session=bad; Path=/' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['set-cookie']).toBeUndefined();
      }
    });

    it('11. 304 tries to change Vary: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'vary': 'Accept-Encoding' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['vary']).toBeUndefined();
      }
    });

    it('12. 304 tries to change Via: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'via': '1.1 new-proxy' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['via']).toBe('1.1 origin');
      }
    });

    it('13. Date from the 304 used when valid', () => {
      const entry = makeBaseEntry();
      const newDate = formatHttpDate(baseTime + 5000);
      const res = applyNotModified(
        entry,
        { headers: { 'date': newDate } },
        { requestTimeMs: baseTime + 5000, responseTimeMs: baseTime + 5010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['date']).toBe(newDate);
        expect(res.entry.dateValueMs).toBe(baseTime + 5000);
      }
    });

    it('14. Proxy Date when missing or invalid in 304', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'date': 'invalid-date-string' } },
        { requestTimeMs: baseTime + 6000, responseTimeMs: baseTime + 6020 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['date']).toBe(formatHttpDate(baseTime + 6020));
        expect(res.entry.dateValueMs).toBe(baseTime + 6020);
      }
    });

    it('15. 304 with Age: 20 starts the new age at 20 s', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'age': '20' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.ageValueSeconds).toBe(20);
      }
    });

    it('16. 304 adding no-store gives not_storable_anymore', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'no-store' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('not_storable_anymore');
    });

    it('17. 304 giving max-age=0 gives not_storable_anymore', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=0' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('not_storable_anymore');
    });

    it('18. a 304 never changes the body Buffer (same reference and same bytes)', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=100' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.body).toBe(entry.body);
        expect(res.entry.body.equals(entry.body)).toBe(true);
        expect(res.entry.size).toBe(entry.size);
      }
    });

    it('19. entry.version differs after refresh in CacheStore', () => {
      const store = new MemoryStore();
      const entry = makeBaseEntry();
      store.set(entry);
      const initialVersion = entry.version;

      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=120' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        store.set(res.entry);
        expect(res.entry.version).toBeGreaterThan(initialVersion!);
      }
    });

    it('20. 304 adds custom header foo: bar', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'x-custom-foo': 'bar' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['x-custom-foo']).toBe('bar');
      }
    });

    it('21. 304 with Connection: x-custom strips x-custom header', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        {
          headers: {
            'connection': 'x-custom',
            'x-custom': 'secret-value',
            'x-keep': 'keep-me',
          },
        },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['x-custom']).toBeUndefined();
        expect(res.entry.headers['x-keep']).toBe('keep-me');
      }
    });

    it('22. 304 tries to change transfer-encoding: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'transfer-encoding': 'chunked' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['transfer-encoding']).toBeUndefined();
      }
    });

    it('23. 304 tries to change content-range: ignored', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'content-range': 'bytes 0-10/100' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['content-range']).toBeUndefined();
      }
    });

    it('24. 304 adding private gives not_storable_anymore', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'private, max-age=60' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('not_storable_anymore');
    });

    it('25. 304 adding no-cache gives not_storable_anymore', () => {
      const entry = makeBaseEntry();
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'no-cache' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('not_storable_anymore');
    });

    it('26. 304 where newAge exceeds new lifetime gives not_storable_anymore', () => {
      const entry = makeBaseEntry();
      // Age is 50s, max-age is 30s -> already stale
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=30', 'age': '50' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('not_storable_anymore');
    });

    it('27. stored entry without ETag adopts valid 304 ETag', () => {
      const entry = makeBaseEntry({
        etag: undefined,
        etagRaw: undefined,
        headers: {
          'content-type': 'text/plain',
          'content-length': originalBody.length.toString(),
          'cache-control': 'max-age=60',
          'date': formatHttpDate(baseTime),
        },
      });
      const res = applyNotModified(
        entry,
        { headers: { 'etag': '"adopted-tag"' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.headers['etag']).toBe('"adopted-tag"');
        expect(res.entry.etag?.opaque).toBe('adopted-tag');
        expect(res.entry.etagRaw).toBe('"adopted-tag"');
      }
    });

    it('28. status code and statusMessage remain identical after refresh', () => {
      const entry = makeBaseEntry({ status: 200, statusMessage: 'OK' });
      const res = applyNotModified(
        entry,
        { headers: { 'cache-control': 'max-age=60' } },
        { requestTimeMs: baseTime + 1000, responseTimeMs: baseTime + 1010 }
      );
      expect(res.kind).toBe('refreshed');
      if (res.kind === 'refreshed') {
        expect(res.entry.status).toBe(200);
        expect(res.entry.statusMessage).toBe('OK');
        expect(res.entry.storedAt).toBe(entry.storedAt);
        expect(res.entry.refreshedAt).toBe(baseTime + 1010);
        expect(res.entry.revalidationCount).toBe(1);
      }
    });
  });
});
