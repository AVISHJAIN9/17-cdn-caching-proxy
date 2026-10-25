import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { formatHttpDate, parseHttpDate } from '../src/cache/http-date.js';
import { resolveOriginResponseDate } from '../src/proxy/date.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';

describe('Feature 1: Date header (src/cache/http-date.ts, src/proxy/date.ts)', () => {
  describe('Unit: formatHttpDate & parseHttpDate', () => {
    it('formats known timestamp to IMF-fixdate format', () => {
      // Sun, 06 Nov 1994 08:49:37 GMT -> 784111777000 ms
      const ms = 784111777000;
      expect(formatHttpDate(ms)).toBe('Sun, 06 Nov 1994 08:49:37 GMT');
    });

    it('matches Date.prototype.toUTCString as an oracle for 2,000 random timestamps (1970-9999)', () => {
      const minEpoch = 0; // 1970-01-01
      const maxEpoch = Date.UTC(9999, 11, 31, 23, 59, 59);

      for (let i = 0; i < 2000; i++) {
        const randMs = Math.floor(minEpoch + Math.random() * (maxEpoch - minEpoch));
        // Clamp to second resolution
        const epochSecondsMs = Math.floor(randMs / 1000) * 1000;
        const formatted = formatHttpDate(epochSecondsMs);
        const oracle = new Date(epochSecondsMs).toUTCString();
        expect(formatted).toBe(oracle);
      }
    });

    it('round-trips 2,000 random timestamps through formatHttpDate and parseHttpDate', () => {
      const minEpoch = 0;
      const maxEpoch = Date.UTC(9999, 11, 31, 23, 59, 59);

      for (let i = 0; i < 2000; i++) {
        const randMs = Math.floor(minEpoch + Math.random() * (maxEpoch - minEpoch));
        const epochSecondsMs = Math.floor(randMs / 1000) * 1000;
        const formatted = formatHttpDate(epochSecondsMs);
        const parsed = parseHttpDate(formatted);
        expect(parsed).toBe(epochSecondsMs);
      }
    });

    it('resolveOriginResponseDate handles missing, invalid, and multiple dates correctly', () => {
      const fakeNow = 1700000000000;
      const expectedFormatted = formatHttpDate(fakeNow);

      // Missing
      const missing = resolveOriginResponseDate(undefined, undefined, fakeNow, 'req-1');
      expect(missing.dateSource).toBe('proxy_added');
      expect(missing.dateHeaderValue).toBe(expectedFormatted);
      expect(missing.dateValueMs).toBe(fakeNow);

      // Invalid
      const invalid = resolveOriginResponseDate('garbage', ['date', 'garbage'], fakeNow, 'req-2');
      expect(invalid.dateSource).toBe('proxy_added');
      expect(invalid.dateHeaderValue).toBe(expectedFormatted);
      expect(invalid.dateValueMs).toBe(fakeNow);

      // Multiple
      const multi = resolveOriginResponseDate(
        ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 09:49:37 GMT'],
        ['Date', 'Sun, 06 Nov 1994 08:49:37 GMT', 'Date', 'Sun, 06 Nov 1994 09:49:37 GMT'],
        fakeNow,
        'req-3'
      );
      expect(multi.dateSource).toBe('proxy_added');
      expect(multi.dateHeaderValue).toBe(expectedFormatted);
      expect(multi.dateValueMs).toBe(fakeNow);

      // Valid single
      const valid = resolveOriginResponseDate('Sun, 06 Nov 1994 08:49:37 GMT', ['date', 'Sun, 06 Nov 1994 08:49:37 GMT'], fakeNow, 'req-4');
      expect(valid.dateSource).toBe('origin');
      expect(valid.dateHeaderValue).toBe('Sun, 06 Nov 1994 08:49:37 GMT');
      expect(valid.dateValueMs).toBe(784111777000);
    });
  });

  describe('Integration (Real sockets & real origin)', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let proxyPort: number;
    let clock: FakeClock;
    let store: MemoryStore;

    // Helper to count Date headers in raw response text
    function countDateHeaders(text: string): number {
      const headerPart = text.split('\r\n\r\n')[0] ?? text.split('\n\n')[0];
      const lines = headerPart.split(/\r?\n/);
      return lines.filter((h) => /^date:/i.test(h.trim())).length;
    }

    function getDateHeaderValue(text: string): string | undefined {
      const headerPart = text.split('\r\n\r\n')[0] ?? text.split('\n\n')[0];
      const lines = headerPart.split(/\r?\n/);
      const line = lines.find((h) => /^date:/i.test(h.trim()));
      return line ? line.slice(line.indexOf(':') + 1).trim() : undefined;
    }

    beforeAll(async () => {
      clock = new FakeClock(1700000000000); // 2023-11-14 22:13:20 GMT
      store = new MemoryStore();
      resetStats();

      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          originPort = (originServer.address() as any).port;
          resolve();
        });
      });

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
        timeouts: {
          upstreamHeadersMs: 300,
        },
      });
      proxyPort = proxyListener.httpPort!;
    });

    afterAll(async () => {
      await proxyListener.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('exactly ONE Date header on proxied 200 (pass-through when uncacheable)', async () => {
      const res = await rawRequest(proxyPort, 'GET /counter-nostore HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
    });

    it('exactly ONE Date header on MISS', async () => {
      const res = await rawRequest(proxyPort, 'GET /validators?cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(countDateHeaders(res.text)).toBe(1);
    });

    it('exactly ONE Date header on HIT, replays stored Date and does not change as time advances', async () => {
      // First prime the cache with a known Date
      const primeDate = 'Tue, 14 Nov 2023 22:13:20 GMT';
      const miss = await rawRequest(
        proxyPort,
        `GET /validators?date=${encodeURIComponent(primeDate)}&cc=max-age%3D300 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');
      expect(countDateHeaders(miss.text)).toBe(1);
      expect(getDateHeaderValue(miss.text)).toBe(primeDate);

      // Advance clock by 60 seconds
      clock.advance(60000);

      // Second request is a cache HIT
      const hit = await rawRequest(
        proxyPort,
        `GET /validators?date=${encodeURIComponent(primeDate)}&cc=max-age%3D300 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(hit.statusCode).toBe(200);
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(countDateHeaders(hit.text)).toBe(1);
      // The Date header MUST NOT have changed when clock advanced
      expect(getDateHeaderValue(hit.text)).toBe(primeDate);
      expect(hit.headers['age']).toBe('60');
    });

    it('origin without Date gets a proxy Date equal to FakeClock time', async () => {
      clock.set(1710000000000);
      const expectedDate = formatHttpDate(1710000000000);

      const res = await rawRequest(
        proxyPort,
        'GET /validators?date=none&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(getDateHeaderValue(res.text)).toBe(expectedDate);
    });

    it('origin with garbage Date is replaced with proxy Date equal to FakeClock time', async () => {
      clock.set(1715000000000);
      const expectedDate = formatHttpDate(1715000000000);

      const res = await rawRequest(
        proxyPort,
        'GET /validators?date=garbage&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(getDateHeaderValue(res.text)).toBe(expectedDate);
    });

    it('origin with invalid format Date ("Fri, 99 Foo 2020 ...") is replaced', async () => {
      clock.set(1720000000000);
      const expectedDate = formatHttpDate(1720000000000);

      const res = await rawRequest(
        proxyPort,
        'GET /validators?date=Fri%2C%2099%20Foo%202020%2000%3A00%3A00%20GMT&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(getDateHeaderValue(res.text)).toBe(expectedDate);
    });

    it('origin with two Date headers is replaced with a single proxy Date', async () => {
      clock.set(1725000000000);
      const expectedDate = formatHttpDate(1725000000000);

      const res = await rawRequest(
        proxyPort,
        'GET /validators?date=multi&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(getDateHeaderValue(res.text)).toBe(expectedDate);
    });

    it('valid origin Date is forwarded byte-identical', async () => {
      const originDate = 'Sun, 06 Nov 1994 08:49:37 GMT';
      const res = await rawRequest(
        proxyPort,
        `GET /validators?date=${encodeURIComponent(originDate)}&cc=no-store HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(getDateHeaderValue(res.text)).toBe(originDate);
    });

    it('exactly ONE Date header on 400 Bad Request', async () => {
      const res = await rawRequest(proxyPort, 'GET /%invalid% HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(400);
      expect(countDateHeaders(res.text)).toBe(1);
    });

    it('exactly ONE Date header on 405 Method Not Allowed', async () => {
      // Create proxy with restricted allowedMethods: ['GET']
      const restrictedProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        allowedMethods: ['GET', 'HEAD'],
      });
      const port = restrictedProxy.httpPort!;

      const res = await rawRequest(port, 'DELETE /test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(405);
      expect(countDateHeaders(res.text)).toBe(1);

      await restrictedProxy.stop();
    });

    it('exactly ONE Date header on 501 Not Implemented', async () => {
      const res = await rawRequest(proxyPort, 'CUSTOMMETHOD /test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(501);
      expect(countDateHeaders(res.text)).toBe(1);
    });

    it('exactly ONE Date header on 502 Bad Gateway', async () => {
      // Connect to dead port
      const deadProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: 'http://127.0.0.1:54321', // No origin listening
        clock,
      });
      const port = deadProxy.httpPort!;

      const res = await rawRequest(port, 'GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(502);
      expect(countDateHeaders(res.text)).toBe(1);

      await deadProxy.stop();
    });

    it('exactly ONE Date header on 504 Gateway Timeout', async () => {
      const timeoutProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        timeouts: {
          upstreamHeadersMs: 50,
        },
      });
      const port = timeoutProxy.httpPort!;

      const res = await rawRequest(port, 'GET /never-respond HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(504);
      expect(countDateHeaders(res.text)).toBe(1);

      await timeoutProxy.stop();
    });

    it('exactly ONE Date header on OPTIONS *', async () => {
      const res = await rawRequest(proxyPort, 'OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(200);
      expect(countDateHeaders(res.text)).toBe(1);
    });

    it('exactly ONE Date header on HEAD error', async () => {
      const res = await rawRequest(proxyPort, 'HEAD /%invalid% HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      expect(res.statusCode).toBe(400);
      expect(countDateHeaders(res.text)).toBe(1);
      expect(res.body.length).toBe(0);
    });

    it('exactly ONE Date header on 304 served from cache (unit validation)', async () => {
      const fakeRes = new http.ServerResponse({} as any);
      let capturedStatus = 0;
      let capturedHeaders: any = {};
      fakeRes.writeHead = ((status: any, messageOrHeaders: any, headersOrUndefined: any) => {
        if (!capturedStatus) {
          capturedStatus = status;
          fakeRes.statusCode = status;
          capturedHeaders = headersOrUndefined || messageOrHeaders || {};
        }
        return fakeRes;
      }) as any;

      const entry = {
        keyHash: 'h1',
        keyString: 's1',
        originId: 'default',
        status: 200,
        statusMessage: 'OK',
        headers: {
          etag: '"v1"',
          date: 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
        body: Buffer.from('hello'),
        size: 5,
        storedAt: 1704067200000,
        hitCount: 1,
        lastAccessedAt: 1704067200000,
        requestTimeMs: 1704067200000,
        responseTimeMs: 1704067200000,
        dateValueMs: 1704067200000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 3600000,
        lifetimeSource: 'max-age' as const,
        dateSource: 'origin' as const,
      };

      const { serveCache304 } = await import('../src/cache/serve.js');
      serveCache304({ entry, clientRes: fakeRes, clock });
      expect(capturedStatus).toBe(304);
      expect(fakeRes.sendDate).toBe(false);
      expect(capturedHeaders['date']).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });
  });
});
