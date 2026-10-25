import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { allowsStaleServing } from '../src/cache/stale.js';
import { CacheEntry } from '../src/cache/store.js';
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

function makeMockEntry(ccHeader: string): CacheEntry {
  return {
    keyHash: 'dummy-hash',
    keyString: 'http://localhost/test',
    originId: 'default',
    status: 200,
    statusMessage: 'OK',
    headers: {
      'cache-control': ccHeader,
      'content-type': 'text/plain',
      date: new Date().toUTCString(),
    },
    body: Buffer.from('stale-marker-payload-12345'),
    size: 26,
    storedAt: 1_000_000,
    hitCount: 1,
    lastAccessedAt: 1_000_000,
    requestTimeMs: 1_000_000,
    responseTimeMs: 1_000_010,
    dateValueMs: 1_000_000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 10_000,
    lifetimeSource: 'max-age',
  };
}

describe('Feature 5: Must-revalidate (RFC 9111)', () => {
  describe('Pure function: allowsStaleServing', () => {
    it('1. allowsStaleServing returns false when must-revalidate is present', () => {
      const entry = makeMockEntry('max-age=10, must-revalidate');
      expect(allowsStaleServing(entry)).toBe(false);
    });

    it('2. allowsStaleServing returns false when proxy-revalidate is present', () => {
      const entry = makeMockEntry('max-age=10, proxy-revalidate');
      expect(allowsStaleServing(entry)).toBe(false);
    });

    it('3. allowsStaleServing returns false when s-maxage is present', () => {
      const entry = makeMockEntry('s-maxage=10');
      expect(allowsStaleServing(entry)).toBe(false);
    });

    it('4. allowsStaleServing returns false when no revalidation directive is present (today always false)', () => {
      const entry = makeMockEntry('max-age=60');
      expect(allowsStaleServing(entry)).toBe(false);
    });

    it('5. allowsStaleServing returns false even with stale-while-revalidate when must-revalidate is present', () => {
      const entry = makeMockEntry('max-age=10, must-revalidate, stale-while-revalidate=60');
      expect(allowsStaleServing(entry)).toBe(false);
    });

    it('6. allowsStaleServing returns false even with stale-if-error when proxy-revalidate is present', () => {
      const entry = makeMockEntry('max-age=10, proxy-revalidate, stale-if-error=60');
      expect(allowsStaleServing(entry)).toBe(false);
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
        timeouts: {
          upstreamConnectMs: 500,
          upstreamHeadersMs: 800,
        },
      });
      proxyPort = proxy.httpPort!;
    });

    afterEach(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('7. Stale entry with must-revalidate and an origin that is down gives 502 and never the stale body', async () => {
      await postJson(originPort, '/__config/must-rev', {
        cc: 'max-age=2, must-revalidate',
      });

      // 1. Prime cache
      const prime = await rawRequest(
        proxyPort,
        'GET /reval/must-rev HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(prime.statusCode).toBe(200);
      const staleBody = prime.body.toString('utf-8');

      // 2. Advance clock so entry becomes stale
      clock.advance(5000);

      // 3. Stop origin server
      await new Promise<void>((resolve) => originServer.close(() => resolve()));

      // 4. Request must get 502 and never the stale body
      const res = await rawRequest(
        proxyPort,
        'GET /reval/must-rev HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(502);
      expect(res.body.toString('utf-8')).not.toContain(staleBody);
    });

    it('8. Stale entry with proxy-revalidate and an origin that is down gives 502 and never the stale body', async () => {
      await postJson(originPort, '/__config/proxy-rev', {
        cc: 'max-age=2, proxy-revalidate',
      });

      const prime = await rawRequest(
        proxyPort,
        'GET /reval/proxy-rev HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(prime.statusCode).toBe(200);
      const staleBody = prime.body.toString('utf-8');

      clock.advance(5000);
      await new Promise<void>((resolve) => originServer.close(() => resolve()));

      const res = await rawRequest(
        proxyPort,
        'GET /reval/proxy-rev HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(502);
      expect(res.body.toString('utf-8')).not.toContain(staleBody);
    });

    it('9. Stale entry with no such directive and an origin that is down gives 502 and never the stale body', async () => {
      await postJson(originPort, '/__config/plain-cc', {
        cc: 'max-age=2',
      });

      const prime = await rawRequest(
        proxyPort,
        'GET /reval/plain-cc HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(prime.statusCode).toBe(200);
      const staleBody = prime.body.toString('utf-8');

      clock.advance(5000);
      await new Promise<void>((resolve) => originServer.close(() => resolve()));

      const res = await rawRequest(
        proxyPort,
        'GET /reval/plain-cc HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(502);
      expect(res.body.toString('utf-8')).not.toContain(staleBody);
    });

    it('10. 504 from a headers timeout during must-revalidate never returns the stale body', async () => {
      let hangSocket: any = null;
      const hangOrigin = net.createServer((sock) => {
        hangSocket = sock;
        // Never send response
      });
      await new Promise<void>((resolve) => hangOrigin.listen(0, '127.0.0.1', () => resolve()));
      const hangPort = (hangOrigin.address() as any).port;

      const slowProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${hangPort}`,
        clock,
        store,
        timeouts: {
          upstreamConnectMs: 500,
          upstreamHeadersMs: 300,
        },
      });

      // Seed a stale entry with must-revalidate
      const staleMarker = 'STALE_BODY_MUST_NEVER_BE_SERVED';
      store.set({
        keyHash: 'hash-must-rev-timeout',
        keyString: `http://127.0.0.1:${hangPort}/reval/timeout-test`,
        originId: 'default',
        status: 200,
        statusMessage: 'OK',
        headers: {
          'content-type': 'text/plain',
          'content-length': String(staleMarker.length),
          'cache-control': 'max-age=10, must-revalidate',
          'etag': '"timeout-v1"',
          'date': 'Sat, 01 Jan 2000 00:00:00 GMT',
        },
        body: Buffer.from(staleMarker),
        size: staleMarker.length,
        storedAt: baseTime,
        hitCount: 1,
        lastAccessedAt: baseTime,
        requestTimeMs: baseTime,
        responseTimeMs: baseTime + 10,
        dateValueMs: baseTime,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 10_000,
        lifetimeSource: 'max-age',
        etagRaw: '"timeout-v1"',
      });

      // Advance clock past 10s -> stale
      clock.advance(20_000);

      const res = await rawRequest(
        slowProxy.httpPort!,
        'GET /reval/timeout-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(504);
      expect(res.body.toString('utf-8')).not.toContain(staleMarker);

      hangSocket?.destroy();
      await slowProxy.stop();
      await new Promise<void>((resolve) => hangOrigin.close(() => resolve()));
    });

    it('11. A 304 that removes must-revalidate from the headers is reflected in the refreshed entry', async () => {
      // Origin initially sends must-revalidate, but 304 response omits must-revalidate
      await postJson(originPort, '/__config/remove-mr', {
        cc: 'max-age=2, must-revalidate',
        cc304: 'max-age=100',
      });

      // Prime
      await rawRequest(
        proxyPort,
        'GET /reval/remove-mr HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Verify stored entry has must-revalidate
      const keys = Array.from((store as any).entries.keys()) as string[];
      const key = keys.find((k: string) => k.includes('remove-mr')) || keys[keys.length - 1];
      const entryBefore = store.get(key);
      expect(entryBefore?.headers['cache-control']).toContain('must-revalidate');

      // Go stale
      clock.advance(5000);

      // Revalidate: origin returns 304 with cc304: max-age=100 (must-revalidate removed)
      const res = await rawRequest(
        proxyPort,
        'GET /reval/remove-mr HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('REVALIDATED');

      const entryAfter = store.get(key);
      expect(entryAfter?.headers['cache-control']).toBe('max-age=100');
      expect(entryAfter?.headers['cache-control']).not.toContain('must-revalidate');
    });

    it('12. Origin 500 during must-revalidate revalidation passes through 500 and never returns stale body', async () => {
      await postJson(originPort, '/__config/mr-500', {
        cc: 'max-age=2, must-revalidate',
      });

      const prime = await rawRequest(
        proxyPort,
        'GET /reval/mr-500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(prime.statusCode).toBe(200);
      const staleBody = prime.body.toString('utf-8');

      // Go stale and set origin status to 500
      clock.advance(5000);
      await postJson(originPort, '/__config/mr-500', {
        status: 500,
      });

      const res = await rawRequest(
        proxyPort,
        'GET /reval/mr-500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(500);
      expect(res.body.toString('utf-8')).not.toContain(staleBody);
    });
  });
});
