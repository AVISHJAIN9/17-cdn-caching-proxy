import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { evaluateClientConditionals } from '../src/cache/preconditions.js';
import { parseEntityTag } from '../src/cache/etag.js';
import { formatHttpDate } from '../src/cache/http-date.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 5: If-Modified-Since (src/cache/preconditions.ts, src/cache/serve.ts)', () => {
  const baseLmMs = 784111777000; // Sun, 06 Nov 1994 08:49:37 GMT
  const baseLmStr = formatHttpDate(baseLmMs);
  const tagV1 = parseEntityTag('"v1"')!;

  describe('Unit: evaluateClientConditionals with If-Modified-Since (17 cases)', () => {
    it('1. Equal date gives not_modified', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: baseLmStr },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_modified_since_not_modified');
    });

    it('2. One second older request date gives proceed', () => {
      const olderStr = formatHttpDate(baseLmMs - 1000);
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: olderStr },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_modified_since_modified');
    });

    it('3. Later request date gives not_modified', () => {
      const laterStr = formatHttpDate(baseLmMs + 1000);
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: laterStr },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_modified_since_not_modified');
    });

    it('4. IMF-fixdate format is accepted', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: 'Sun, 06 Nov 1994 08:49:37 GMT' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_modified_since_not_modified');
    });

    it('5. RFC 850 format is accepted', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: 'Sunday, 06-Nov-94 08:49:37 GMT' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_modified_since_not_modified');
    });

    it('6. ANSI C asctime format is accepted', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: 'Sun Nov  6 08:49:37 1994' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_modified_since_not_modified');
    });

    it('7. Invalid date "garbage" gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: 'garbage' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_modified_since_invalid');
    });

    it('8. Invalid date "0" gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: '0' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_modified_since_invalid');
    });

    it('9. Two IMS headers give proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: [baseLmStr, baseLmStr] },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_modified_since_multiple');
    });

    it('10. Entry without Last-Modified gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: baseLmStr },
        {}
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('no_stored_last_modified');
    });

    it('11. INM present and not matching plus IMS that would match gives proceed (INM wins, IMS ignored)', () => {
      const res = evaluateClientConditionals(
        {
          method: 'GET',
          ifNoneMatch: '"v2"', // does not match tagV1
          ifModifiedSince: baseLmStr, // would match
        },
        {
          etag: tagV1,
          lastModifiedMs: baseLmMs,
        }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_no_match');
    });

    it('12. INM invalid plus IMS that would match gives proceed (INM disables IMS)', () => {
      const res = evaluateClientConditionals(
        {
          method: 'GET',
          ifNoneMatch: 'garbage', // invalid tag list
          ifModifiedSince: baseLmStr, // would match
        },
        {
          etag: tagV1,
          lastModifiedMs: baseLmMs,
        }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_invalid');
    });

    it('13. INM matching gives not_modified regardless of IMS', () => {
      const olderStr = formatHttpDate(baseLmMs - 10000);
      const res = evaluateClientConditionals(
        {
          method: 'GET',
          ifNoneMatch: '"v1"', // matches
          ifModifiedSince: olderStr, // would NOT match
        },
        {
          etag: tagV1,
          lastModifiedMs: baseLmMs,
        }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('14. IMS on POST is not evaluated and returns proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'POST', ifModifiedSince: baseLmStr },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('method_not_get');
    });

    it('15. IMS on PUT is not evaluated and returns proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'PUT', ifModifiedSince: baseLmStr },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('method_not_get');
    });

    it('16. Exact millisecond comparison: 1 ms earlier gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifModifiedSince: formatHttpDate(baseLmMs) },
        { lastModifiedMs: baseLmMs + 1 } // entry modified 1 ms after IMS date
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_modified_since_modified');
    });

    it('17. Both INM and IMS absent returns proceed with no_conditionals', () => {
      const res = evaluateClientConditionals(
        { method: 'GET' },
        { lastModifiedMs: baseLmMs }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('no_conditionals');
    });
  });

  describe('Integration: Real proxy, real demo origin, real sockets (10 cases)', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let store: MemoryStore;
    let clock: FakeClock;
    let proxyPort: number;

    const baseClockTime = 1000000000000;
    const originLmMs = 1000000000000 - 1000 * 1000;
    const originLmStr = formatHttpDate(originLmMs);

    beforeEach(async () => {
      resetStats();
      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          originPort = (originServer.address() as any).port;
          resolve();
        });
      });

      clock = new FakeClock(baseClockTime);
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

    async function getOriginStats(): Promise<any> {
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${originPort}/__stats`, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(JSON.parse(text)));
          res.on('error', reject);
        });
      });
    }

    it('1. Equal date gives 304 and zero extra origin requests', async () => {
      // Prime the cache
      const miss = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');

      const originStatsBefore = await getOriginStats();

      // Conditional GET with exact equal date
      const hit304 = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${originLmStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
      expect(hit304.body.toString('utf-8')).toBe('');

      // Origin stats verify zero extra requests
      const originStatsAfter = await getOriginStats();
      expect(originStatsAfter.requests).toBe(originStatsBefore.requests);
    });

    it('2. Later request date gives 304 and zero extra origin requests', async () => {
      await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      const originStatsBefore = await getOriginStats();

      const laterDateStr = formatHttpDate(originLmMs + 100000);
      const hit304 = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${laterDateStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');

      const originStatsAfter = await getOriginStats();
      expect(originStatsAfter.requests).toBe(originStatsBefore.requests);
    });

    it('3. One second older request date gives 200 with full body from cache', async () => {
      const miss = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      const originStatsBefore = await getOriginStats();

      const olderDateStr = formatHttpDate(originLmMs - 1000);
      const hit200 = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${olderDateStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));

      const originStatsAfter = await getOriginStats();
      expect(originStatsAfter.requests).toBe(originStatsBefore.requests);
    });

    it('4. All three date formats accepted through real proxy', async () => {
      const lm1994 = 'Sun, 06 Nov 1994 08:49:37 GMT';
      await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(lm1994)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );

      // IMF-fixdate
      const imfRes = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(lm1994)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: Sun, 06 Nov 1994 08:49:37 GMT\r\nConnection: close\r\n\r\n`
      );
      expect(imfRes.statusCode).toBe(304);

      // RFC 850
      const rfc850Res = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(lm1994)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: Sunday, 06-Nov-94 08:49:37 GMT\r\nConnection: close\r\n\r\n`
      );
      expect(rfc850Res.statusCode).toBe(304);

      // asctime
      const asctimeRes = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(lm1994)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: Sun Nov  6 08:49:37 1994\r\nConnection: close\r\n\r\n`
      );
      expect(asctimeRes.statusCode).toBe(304);
    });

    it('5. Invalid date gives 200 with full body', async () => {
      const miss = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      const hit200 = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: invalid-date\r\nConnection: close\r\n\r\n`
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));
    });

    it('6. Two IMS headers give 200 with full body', async () => {
      const miss = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      const hit200 = await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${originLmStr}\r\nIf-Modified-Since: ${originLmStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));
    });

    it('7. Entry without Last-Modified gives 200 with full body', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.headers['last-modified']).toBeUndefined();

      const hit200 = await rawRequest(
        proxyPort,
        `GET /validators?cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${originLmStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));
    });

    it('8. INM present and not matching plus IMS that would match gives 200 (INM wins)', async () => {
      await rawRequest(
        proxyPort,
        `GET /validators?etag=%22v1%22&lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );

      const hit200 = await rawRequest(
        proxyPort,
        `GET /validators?etag=%22v1%22&lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "nomatch"\r\nIf-Modified-Since: ${originLmStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
    });

    it('9. INM matching gives 304 regardless of older IMS date', async () => {
      await rawRequest(
        proxyPort,
        `GET /validators?etag=%22v1%22&lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );

      const olderStr = formatHttpDate(originLmMs - 10000);
      const hit304 = await rawRequest(
        proxyPort,
        `GET /validators?etag=%22v1%22&lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nIf-Modified-Since: ${olderStr}\r\nConnection: close\r\n\r\n`
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('10. Origin /__stats shows zero extra requests for every 304 served from cache', async () => {
      await rawRequest(
        proxyPort,
        `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      const stats1 = await getOriginStats();

      // Send 5 conditional requests that hit
      for (let i = 0; i < 5; i++) {
        const hit = await rawRequest(
          proxyPort,
          `GET /validators?lm=${encodeURIComponent(originLmStr)}&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: ${originLmStr}\r\nConnection: close\r\n\r\n`
        );
        expect(hit.statusCode).toBe(304);
      }

      const stats2 = await getOriginStats();
      expect(stats2.requests).toBe(stats1.requests);
      expect(store.stats().notModified).toBe(5);
    });
  });
});
