import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { freshnessLifetimeMs } from '../src/cache/lifetime.js';
import { parseCacheControl } from '../src/cache/cache-control.js';
import { checkRequestBypass, checkResponseStorableFromHeaders } from '../src/cache/policy.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';

function rawRequest(
  port: number,
  requestRaw: string
): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer; raw: string }> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.write(requestRaw);
    });

    const chunks: Buffer[] = [];
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('error', reject);
    client.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const headerEndIndex = raw.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        return resolve({ statusCode: 0, headers: {}, body: Buffer.alloc(0), raw });
      }

      const headerPart = raw.slice(0, headerEndIndex);
      const bodyPart = Buffer.concat(chunks).subarray(
        Buffer.byteLength(headerPart, 'utf-8') + 4
      );

      const lines = headerPart.split('\r\n');
      const statusLine = lines[0];
      const match = statusLine.match(/HTTP\/1\.[01]\s+(\d{3})/);
      const statusCode = match ? parseInt(match[1], 10) : 0;

      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const idx = line.indexOf(':');
        if (idx !== -1) {
          const name = line.slice(0, idx).trim().toLowerCase();
          const val = line.slice(idx + 1).trim();
          headers[name] = val;
        }
      }

      resolve({ statusCode, headers, body: bodyPart, raw });
    });
  });
}

function postJson(port: number, path: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

describe('Feature 4: S-maxage (RFC 9111)', () => {
  describe('Pure Lifetime Function', () => {
    it('1. s-maxage takes precedence over max-age', () => {
      const cc = parseCacheControl('max-age=1000, s-maxage=20');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(20_000);
    });

    it('2. s-maxage takes precedence over Expires', () => {
      const cc = parseCacheControl('s-maxage=30');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        expiresHeader: 'Sun, 01 Jan 2030 00:00:00 GMT',
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(30_000);
    });

    it('3. s-maxage takes precedence over both max-age and Expires', () => {
      const cc = parseCacheControl('max-age=500, s-maxage=40');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        expiresHeader: 'Sun, 01 Jan 2030 00:00:00 GMT',
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(40_000);
    });

    it('4. s-maxage=0 with max-age=60 returns lifetimeMs 0', () => {
      const cc = parseCacheControl('max-age=60, s-maxage=0');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(0);
    });

    it('5. s-maxage with invalid value returns source: invalid and lifetimeMs: 0', () => {
      const cc = parseCacheControl('s-maxage=invalid, max-age=60');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('invalid');
      expect(res.lifetimeMs).toBe(0);
    });

    it('6. s-maxage with conflicting duplicate values returns source: invalid and lifetimeMs: 0', () => {
      const cc = parseCacheControl('s-maxage=10, s-maxage=20');
      const res = freshnessLifetimeMs({
        cacheControl: cc,
        dateMs: 1_000_000,
      });
      expect(res.source).toBe('invalid');
      expect(res.lifetimeMs).toBe(0);
    });

    it('7. s-maxage is capped at maxTtlMs when exceeding it', () => {
      const cc = parseCacheControl('s-maxage=100000');
      const res = freshnessLifetimeMs(
        {
          cacheControl: cc,
          dateMs: 1_000_000,
        },
        { maxTtlMs: 50_000 }
      );
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(50_000);
    });

    it('8. s-maxage is NOT capped below maxTtlMs unless it exceeds it', () => {
      const cc = parseCacheControl('s-maxage=30');
      const res = freshnessLifetimeMs(
        {
          cacheControl: cc,
          dateMs: 1_000_000,
        },
        { maxTtlMs: 60_000 }
      );
      expect(res.source).toBe('s-maxage');
      expect(res.lifetimeMs).toBe(30_000);
    });
  });

  describe('Storability and Request Policy', () => {
    it('9. Response with s-maxage but also private is not stored (private wins)', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          'cache-control': 's-maxage=3600, private',
          date: new Date().toUTCString(),
        },
        requestTimeMs: 1000,
        responseTimeMs: 1010,
      });
      expect(res.storable).toBe(false);
      expect(res.reason).toBe('private');
    });

    it('10. Response with s-maxage=0 and max-age=60 is not stored (zero_lifetime)', () => {
      const res = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          'cache-control': 'max-age=60, s-maxage=0',
          date: new Date().toUTCString(),
        },
        requestTimeMs: 1000,
        responseTimeMs: 1010,
      });
      expect(res.storable).toBe(false);
      expect(res.reason).toBe('zero_lifetime');
    });

    it('11. s-maxage in request Cache-Control is ignored (parsed only, not bypassed)', () => {
      const bypassCheck = checkRequestBypass({
        method: 'GET',
        headers: {
          'cache-control': 's-maxage=0',
        },
      });
      expect(bypassCheck.bypass).toBe(false);
    });
  });

  describe('Integration with Proxy & Origin', () => {
    let originPort: number;
    let proxyPort: number;
    let clock: FakeClock;
    let store: MemoryStore;
    let proxy: any;
    const baseTime = 1_000_000;

    beforeEach(async () => {
      resetStats();
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      clock = new FakeClock(baseTime);
      store = new MemoryStore({ maxEntries: 50, maxTotalBytes: 1024 * 1024 });

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        store,
        cache: {
          enabled: true,
          debugHeaders: true,
          revalidate: { enabled: true },
        },
      });
      proxyPort = proxy.httpPort!;
    });

    afterEach(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('12. First store uses s-maxage over max-age and goes stale according to s-maxage', async () => {
      // Origin cc: max-age=1000, s-maxage=2
      await postJson(originPort, '/__config/smax-test', {
        cc: 'max-age=1000, s-maxage=2',
      });

      // 1. Prime cache (MISS)
      const res1 = await rawRequest(
        proxyPort,
        'GET /reval/smax-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-cache']).toBe('MISS');

      // 2. Immediate hit within 1s
      clock.advance(1000);
      const res2 = await rawRequest(
        proxyPort,
        'GET /reval/smax-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res2.statusCode).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');

      // 3. Advance clock past 2s (stale under s-maxage, even though max-age is 1000)
      clock.advance(2000);
      const res3 = await rawRequest(
        proxyPort,
        'GET /reval/smax-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res3.statusCode).toBe(200);
      expect(res3.headers['x-cache']).toBe('REVALIDATED');
    });

    it('13. 304 refresh updates s-maxage extending freshness lifetime', async () => {
      // Initially s-maxage=2, but 304 will set s-maxage=100
      await postJson(originPort, '/__config/smax-extend', {
        cc: 'max-age=1000, s-maxage=2',
        cc304: 'max-age=1000, s-maxage=100',
      });

      // Prime cache
      await rawRequest(
        proxyPort,
        'GET /reval/smax-extend HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Go stale past 2s
      clock.advance(3000);

      // Revalidate: origin sends 304 with cc304 s-maxage=100
      const resReval = await rawRequest(
        proxyPort,
        'GET /reval/smax-extend HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(resReval.statusCode).toBe(200);
      expect(resReval.headers['x-cache']).toBe('REVALIDATED');

      // Advance clock past old 2s lifetime (e.g. 5s later)
      clock.advance(5000);
      const resHit = await rawRequest(
        proxyPort,
        'GET /reval/smax-extend HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(resHit.statusCode).toBe(200);
      expect(resHit.headers['x-cache']).toBe('HIT');
    });

    it('14. 304 refresh changing s-maxage to 0 deletes entry after serving once', async () => {
      await postJson(originPort, '/__config/smax-zero', {
        cc: 'max-age=60, s-maxage=10',
        cc304: 'max-age=60, s-maxage=0',
      });

      // Prime
      await rawRequest(
        proxyPort,
        'GET /reval/smax-zero HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(store.stats().entries).toBe(1);

      // Advance clock so it's stale
      clock.advance(15_000);

      // Revalidate: origin sends 304 with s-maxage=0 -> not_storable_anymore
      const res = await rawRequest(
        proxyPort,
        'GET /reval/smax-zero HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(store.stats().entries).toBe(0); // Deleted!

      // Next request is a plain MISS
      const resMiss = await rawRequest(
        proxyPort,
        'GET /reval/smax-zero HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(resMiss.statusCode).toBe(200);
      expect(resMiss.headers['x-cache']).toBe('MISS');
    });

    it('15. Per RFC 9111, stale s-maxage entry is never served stale when origin is down', async () => {
      await postJson(originPort, '/__config/smax-nostale', {
        cc: 's-maxage=5',
      });

      await rawRequest(
        proxyPort,
        'GET /reval/smax-nostale HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Go stale
      clock.advance(10_000);

      // Stop origin
      await new Promise<void>((resolve) => originServer.close(() => resolve()));

      // Request must get 502, never the stale body
      const res = await rawRequest(
        proxyPort,
        'GET /reval/smax-nostale HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(502);
      expect(res.body.toString('utf-8')).not.toContain('id=smax-nostale');
    });

    it('16. Origin 200 with s-maxage=0 is not stored', async () => {
      await postJson(originPort, '/__config/smax-zero-init', {
        cc: 'max-age=60, s-maxage=0',
      });

      const res = await rawRequest(
        proxyPort,
        'GET /reval/smax-zero-init HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(store.stats().entries).toBe(0);
    });

    it('17. Origin 200 with s-maxage and private is not stored', async () => {
      await postJson(originPort, '/__config/smax-priv-init', {
        cc: 's-maxage=60, private',
      });

      const res = await rawRequest(
        proxyPort,
        'GET /reval/smax-priv-init HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(store.stats().entries).toBe(0);
    });
  });
});
