import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../src/util/clock.js';
import { resolveResponseLastModified } from '../src/cache/validators.js';
import { freshnessLifetimeMs, LifetimeConfig } from '../src/cache/lifetime.js';
import { checkResponseStorableFromHeaders } from '../src/cache/policy.js';
import { parseCacheControl } from '../src/cache/cache-control.js';
import { formatHttpDate } from '../src/cache/http-date.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 3: Last-Modified and Heuristic Freshness', () => {
  describe('Unit: resolveResponseLastModified', () => {
    it('parses IMF-fixdate format', () => {
      const res = resolveResponseLastModified('Sun, 06 Nov 1994 08:49:37 GMT', undefined);
      expect(res).toBe(784111777000);
    });

    it('parses RFC 850 format', () => {
      const res = resolveResponseLastModified('Sunday, 06-Nov-94 08:49:37 GMT', undefined);
      expect(res).toBe(784111777000);
    });

    it('parses ANSI C asctime format', () => {
      const res = resolveResponseLastModified('Sun Nov  6 08:49:37 1994', undefined);
      expect(res).toBe(784111777000);
    });

    it('returns undefined and logs when multiple Last-Modified headers are present', () => {
      const res1 = resolveResponseLastModified(
        ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 09:49:37 GMT'],
        undefined
      );
      expect(res1).toBeUndefined();

      const res2 = resolveResponseLastModified(
        'Sun, 06 Nov 1994 08:49:37 GMT',
        ['Last-Modified', 'Sun, 06 Nov 1994 08:49:37 GMT', 'Last-Modified', 'Sun, 06 Nov 1994 09:49:37 GMT']
      );
      expect(res2).toBeUndefined();
    });

    it('returns undefined when Last-Modified is invalid', () => {
      expect(resolveResponseLastModified('garbage', undefined)).toBeUndefined();
      expect(resolveResponseLastModified('', undefined)).toBeUndefined();
      expect(resolveResponseLastModified('0', undefined)).toBeUndefined();
    });

    it('returns undefined when Last-Modified is absent', () => {
      expect(resolveResponseLastModified(undefined, undefined)).toBeUndefined();
    });
  });

  describe('Unit: Table-driven freshnessLifetimeMs and heuristic freshness (25 rows)', () => {
    const baseDate = 1000000000000; // e.g. 2001-09-09

    interface TableRow {
      desc: string;
      cc?: string;
      expires?: string;
      dateMs: number;
      lastModifiedMs?: number;
      config?: LifetimeConfig;
      expectedLifetimeMs: number;
      expectedSource: string;
    }

    const testCases: TableRow[] = [
      // 1. Last-Modified 1000 s before Date with ratio 0.1 gives exactly 100 s (100,000 ms)
      {
        desc: 'Last-Modified 1000 s before Date with default ratio 0.1 gives 100 s',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 100 * 1000,
        expectedSource: 'heuristic',
      },
      // 2. 20 days before Date is capped at 24 h (86,400,000 ms)
      {
        desc: '20 days before Date is capped at default maxMs (24 h)',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 20 * 86400 * 1000,
        expectedLifetimeMs: 86400 * 1000,
        expectedSource: 'heuristic',
      },
      // 3. Ratio 1 with 500 s delta gives 500 s
      {
        desc: 'Ratio 1.0 gives 100% of delta',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 500 * 1000,
        config: { heuristic: { enabled: true, ratio: 1.0, maxMs: 86400000 } },
        expectedLifetimeMs: 500 * 1000,
        expectedSource: 'heuristic',
      },
      // 4. Heuristic disabled gives no_freshness_info (source none)
      {
        desc: 'Heuristic disabled gives source none',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        config: { heuristic: { enabled: false, ratio: 0.1, maxMs: 86400000 } },
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 5. Last-Modified equal to Date gives zero_lifetime
      {
        desc: 'Last-Modified equal to Date gives zero lifetime with source heuristic',
        dateMs: baseDate,
        lastModifiedMs: baseDate,
        expectedLifetimeMs: 0,
        expectedSource: 'heuristic',
      },
      // 6. Last-Modified after Date gives no heuristic (source none)
      {
        desc: 'Last-Modified after Date (future) gives source none',
        dateMs: baseDate,
        lastModifiedMs: baseDate + 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 7. Invalid Last-Modified (undefined) gives no heuristic
      {
        desc: 'Undefined Last-Modified gives source none',
        dateMs: baseDate,
        lastModifiedMs: undefined,
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 8. Explicit max-age wins over heuristic
      {
        desc: 'Explicit max-age wins over heuristic',
        cc: 'max-age=60',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 60 * 1000,
        expectedSource: 'max-age',
      },
      // 9. Explicit s-maxage wins over heuristic
      {
        desc: 'Explicit s-maxage wins over heuristic',
        cc: 's-maxage=120, max-age=60',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 120 * 1000,
        expectedSource: 's-maxage',
      },
      // 10. Valid Expires disables heuristic
      {
        desc: 'Valid Expires disables heuristic and uses Expires',
        expires: formatHttpDate(baseDate + 300 * 1000),
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 300 * 1000,
        expectedSource: 'expires',
      },
      // 11. Invalid Expires disables heuristic (means already expired per Batch 5)
      {
        desc: 'Invalid Expires disables heuristic and yields 0 expires',
        expires: 'invalid-date',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'expires',
      },
      // 12. "0" Expires disables heuristic
      {
        desc: 'Expires 0 disables heuristic',
        expires: '0',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'expires',
      },
      // 13. CC no-store prevents heuristic
      {
        desc: 'CC no-store prevents heuristic',
        cc: 'no-store',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 14. CC private prevents heuristic
      {
        desc: 'CC private prevents heuristic',
        cc: 'private',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 15. CC no-cache prevents heuristic
      {
        desc: 'CC no-cache prevents heuristic',
        cc: 'no-cache',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'none',
      },
      // 16. Custom ratio 0.2 gives 200 s for 1000 s delta
      {
        desc: 'Custom ratio 0.2 gives 20% delta',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        config: { heuristic: { enabled: true, ratio: 0.2, maxMs: 86400000 } },
        expectedLifetimeMs: 200 * 1000,
        expectedSource: 'heuristic',
      },
      // 17. Custom maxMs 10 s caps heuristic
      {
        desc: 'Custom maxMs caps 100 s heuristic to 10 s',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        config: { heuristic: { enabled: true, ratio: 0.1, maxMs: 10 * 1000 } },
        expectedLifetimeMs: 10 * 1000,
        expectedSource: 'heuristic',
      },
      // 18. Last-Modified 1 s before Date with ratio 0.1 gives 0 ms (floor(0.1*1000) = 100 ms)
      {
        desc: 'Small delta 1 second gives 100 ms',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000,
        expectedLifetimeMs: 100,
        expectedSource: 'heuristic',
      },
      // 19. Last-Modified 5 ms before Date with ratio 0.1 gives 0 ms (floor(0.5) = 0)
      {
        desc: 'Tiny delta 5 ms gives 0 ms floor',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 5,
        expectedLifetimeMs: 0,
        expectedSource: 'heuristic',
      },
      // 20. Ratio 0.5 with 200 s delta gives 100 s
      {
        desc: 'Ratio 0.5 with 200 s delta gives 100 s',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 200 * 1000,
        config: { heuristic: { enabled: true, ratio: 0.5, maxMs: 86400000 } },
        expectedLifetimeMs: 100 * 1000,
        expectedSource: 'heuristic',
      },
      // 21. Max-age 0 wins over heuristic
      {
        desc: 'Max-age 0 wins over heuristic giving 0 max-age',
        cc: 'max-age=0',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'max-age',
      },
      // 22. Max-age with invalid syntax returns 0 invalid
      {
        desc: 'Invalid max-age returns source invalid',
        cc: 'max-age=foo',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'invalid',
      },
      // 23. S-maxage with invalid syntax returns 0 invalid
      {
        desc: 'Invalid s-maxage returns source invalid',
        cc: 's-maxage=bar',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 1000 * 1000,
        expectedLifetimeMs: 0,
        expectedSource: 'invalid',
      },
      // 24. Clamping to config.maxTtlMs
      {
        desc: 'Clamping to maxTtlMs config',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 10000 * 1000,
        config: { maxTtlMs: 50 * 1000 },
        expectedLifetimeMs: 50 * 1000,
        expectedSource: 'heuristic',
      },
      // 25. Large delta 100 days
      {
        desc: 'Large delta 100 days capped at 24 h',
        dateMs: baseDate,
        lastModifiedMs: baseDate - 100 * 86400 * 1000,
        expectedLifetimeMs: 86400 * 1000,
        expectedSource: 'heuristic',
      },
    ];

    for (const [idx, tc] of testCases.entries()) {
      it(`Case ${idx + 1}: ${tc.desc}`, () => {
        const parsedCc = parseCacheControl(tc.cc);
        const res = freshnessLifetimeMs(
          {
            cacheControl: parsedCc,
            expiresHeader: tc.expires,
            dateMs: tc.dateMs,
            lastModifiedMs: tc.lastModifiedMs,
          },
          tc.config
        );
        expect(res.lifetimeMs).toBe(tc.expectedLifetimeMs);
        expect(res.source).toBe(tc.expectedSource);
      });
    }
  });

  describe('Unit: checkResponseStorableFromHeaders storability integration', () => {
    const baseDate = 1000000000000;

    it('rejects future Last-Modified with no_freshness_info', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          date: formatHttpDate(baseDate),
          'last-modified': formatHttpDate(baseDate + 10000),
        },
        requestTimeMs: baseDate,
        responseTimeMs: baseDate,
      });
      expect(res.storable).toBe(false);
      expect(res.reason).toBe('no_freshness_info');
    });

    it('rejects Last-Modified equal to Date with zero_lifetime', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          date: formatHttpDate(baseDate),
          'last-modified': formatHttpDate(baseDate),
        },
        requestTimeMs: baseDate,
        responseTimeMs: baseDate,
      });
      expect(res.storable).toBe(false);
      expect(res.reason).toBe('zero_lifetime');
    });

    it('stores response with valid past Last-Modified via heuristic', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          date: formatHttpDate(baseDate),
          'last-modified': formatHttpDate(baseDate - 1000 * 1000), // 1000 s ago
        },
        requestTimeMs: baseDate,
        responseTimeMs: baseDate,
      });
      expect(res.storable).toBe(true);
      expect(res.metadata?.lifetimeSource).toBe('heuristic');
      expect(res.metadata?.freshnessLifetimeMs).toBe(100 * 1000);
      expect(res.metadata?.lastModifiedMs).toBe(baseDate - 1000 * 1000);
    });

    it('rejects response with two Last-Modified headers with no_freshness_info', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          date: formatHttpDate(baseDate),
          'last-modified': [formatHttpDate(baseDate - 100000), formatHttpDate(baseDate - 50000)],
        },
        rawHeaders: [
          'Date', formatHttpDate(baseDate),
          'Last-Modified', formatHttpDate(baseDate - 100000),
          'Last-Modified', formatHttpDate(baseDate - 50000),
        ],
        requestTimeMs: baseDate,
        responseTimeMs: baseDate,
      });
      expect(res.storable).toBe(false);
      expect(res.reason).toBe('no_freshness_info');
    });
  });

  describe('Integration (Real sockets, real demo origin, FakeClock)', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let store: MemoryStore;
    let clock: FakeClock;
    let proxyPort: number;

    const initialTime = 1000000000000; // Fake epoch
    const originDateStr = formatHttpDate(initialTime);
    const originLmStr = formatHttpDate(initialTime - 1000 * 1000); // 1000 s earlier -> 100 s heuristic lifetime

    beforeEach(async () => {
      resetStats();
      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          originPort = (originServer.address() as any).port;
          resolve();
        });
      });

      clock = new FakeClock(initialTime);
      store = new MemoryStore();
      proxyListener = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        store,
        cache: {
          enabled: true,
          debugHeaders: true,
          maxObjectBytes: 5 * 1024 * 1024,
        },
      });
      proxyPort = proxyListener.httpPort!;
    });

    afterEach(async () => {
      await proxyListener?.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('/validators with only an old lm is MISS then HIT, goes stale at computed boundary and then misses', async () => {
      const url = `/validators?date=none&lm=${encodeURIComponent(originLmStr)}`;

      // 1. First request: MISS
      const miss = await rawRequest(
        proxyPort,
        `GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');
      expect(miss.headers['last-modified']).toBe(originLmStr);

      // Verify stored entry has lastModifiedMs and heuristic freshness
      const entries = (store as any).entries;
      let foundEntry: any;
      for (const e of entries.values()) {
        if (e.keyString.includes('/validators')) {
          foundEntry = e;
          break;
        }
      }
      expect(foundEntry).toBeDefined();
      expect(foundEntry.lastModifiedMs).toBe(initialTime - 1000 * 1000);
      expect(foundEntry.lifetimeSource).toBe('heuristic');
      expect(foundEntry.freshnessLifetimeMs).toBe(100 * 1000); // 100 seconds

      // 2. Second request immediately (clock at +10s): HIT
      clock.advance(10 * 1000);
      const hit = await rawRequest(
        proxyPort,
        `GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(hit.statusCode).toBe(200);
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.headers['last-modified']).toBe(originLmStr);

      // 3. Third request past heuristic lifetime (clock advances past 100s, total 105s): MISS (expired)
      clock.advance(95 * 1000); // now at 105 s
      const expiredMiss = await rawRequest(
        proxyPort,
        `GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(expiredMiss.statusCode).toBe(200);
      expect(expiredMiss.headers['x-cache']).toBe('MISS');
      expect(expiredMiss.headers['x-cache-reason']).toBe('revalidated_replaced');
    });

    it('/validators with no validators and no freshness info is never stored', async () => {
      const url = '/validators?date=none';
      const res = await rawRequest(
        proxyPort,
        `GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-cache-reason']).toBe('no_freshness_info');

      // Verify not stored in cache
      const entries = (store as any).entries;
      let found = false;
      for (const e of entries.values()) {
        if (e.keyString.includes('/validators?date=none')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(false);
    });
  });
});
