import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 75: Partial caching', () => {
  let originServer: http.Server;
  let proxy: ProxyListener;
  let originPort: number;
  let proxyPort: number;
  let upstreamFetchCount = 0;
  const fullBody = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(40); // 1040 bytes

  beforeEach(async () => {
    upstreamFetchCount = 0;

    originServer = http.createServer((req, res) => {
      upstreamFetchCount++;

      if (req.url === '/partial-origin') {
        // Origin returns 206 Partial Content directly
        res.statusCode = 206;
        res.setHeader('Content-Range', 'bytes 0-9/100');
        res.setHeader('Content-Length', '10');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end('0123456789');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('ETag', '"v1-full-resource"');
      res.setHeader('Last-Modified', 'Wed, 21 Oct 2026 07:28:00 GMT');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', Buffer.byteLength(fullBody));
      res.end(fullBody);
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as AddressInfo).port;

    const store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      range: true, // Enable partial caching
      cache: {
        enabled: true,
        debugHeaders: true,
        range: true,
      },
      compression: { enabled: false },
    });

    proxyPort = proxy.httpPort!;
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (originServer) {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  it('serves 206 Partial Content directly from cached complete object with single upstream fetch', async () => {
    // 1. Warm cache with full GET
    const warmRes = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
    expect(warmRes.status).toBe(200);
    expect(await warmRes.text()).toBe(fullBody);
    expect(upstreamFetchCount).toBe(1);

    // 2. Request first 10 bytes via Range
    const rangeRes = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { Range: 'bytes=0-9' },
    });

    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-9/${fullBody.length}`);
    expect(rangeRes.headers.get('content-length')).toBe('10');
    expect(rangeRes.headers.get('x-cache')).toBe('HIT');
    const rangeText = await rangeRes.text();
    expect(rangeText).toBe('ABCDEFGHIJ');

    // Upstream fetch count must still be 1 (served completely from cache)
    expect(upstreamFetchCount).toBe(1);
  });

  it('serves multiple different ranges from the same cached object', async () => {
    // Warm cache
    await fetch(`http://127.0.0.1:${proxyPort}/resource`);
    expect(upstreamFetchCount).toBe(1);

    // Range 1: bytes=26-51 (second block of 26 letters)
    const r1 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { Range: 'bytes=26-51' },
    });
    expect(r1.status).toBe(206);
    expect(r1.headers.get('content-range')).toBe(`bytes 26-51/${fullBody.length}`);
    expect(await r1.text()).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');

    // Range 2: open-ended bytes=1030-
    const r2 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { Range: 'bytes=1030-' },
    });
    expect(r2.status).toBe(206);
    expect(r2.headers.get('content-range')).toBe(`bytes 1030-1039/${fullBody.length}`);
    expect(await r2.text()).toBe(fullBody.slice(1030));

    // Range 3: suffix bytes=-10
    const r3 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { Range: 'bytes=-10' },
    });
    expect(r3.status).toBe(206);
    expect(r3.headers.get('content-range')).toBe(`bytes 1030-1039/${fullBody.length}`);
    expect(await r3.text()).toBe(fullBody.slice(-10));

    expect(upstreamFetchCount).toBe(1);
  });

  it('returns 416 Range Not Satisfiable when range is out of bounds for cached object', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/resource`);
    expect(upstreamFetchCount).toBe(1);

    const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { Range: 'bytes=5000-6000' },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${fullBody.length}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(upstreamFetchCount).toBe(1);
  });

  function makeRequest(
    port: number,
    path: string,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('evaluates If-Range against cached representation', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/resource`);

    // Matching If-Range -> 206
    const matchRes = await makeRequest(proxyPort, '/resource', {
      Range: 'bytes=0-4',
      'If-Range': '"v1-full-resource"',
    });
    expect(matchRes.status).toBe(206);
    expect(matchRes.body).toBe('ABCDE');

    // Mismatched If-Range -> 200 with full cached body
    const mismatchRes = await makeRequest(proxyPort, '/resource', {
      Range: 'bytes=0-4',
      'If-Range': '"stale-etag-999"',
    });
    expect(mismatchRes.status).toBe(200);
    expect(mismatchRes.body).toBe(fullBody);

    expect(upstreamFetchCount).toBe(1);
  });

  it('does NOT cache incomplete 206 Partial Content response from origin', async () => {
    // 1. First fetch of origin 206
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/partial-origin`);
    expect(res1.status).toBe(206);
    expect(await res1.text()).toBe('0123456789');
    expect(upstreamFetchCount).toBe(1);

    // 2. Second fetch must contact upstream again (not cached)
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/partial-origin`);
    expect(res2.status).toBe(206);
    expect(await res2.text()).toBe('0123456789');
    expect(upstreamFetchCount).toBe(2);
  });
});
