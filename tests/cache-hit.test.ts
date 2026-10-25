import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';

describe('Feature 5: Cache hit (src/cache/serve.ts)', () => {
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;
  let clock: FakeClock;

  beforeAll(async () => {
    resetStats();
    clock = new FakeClock(1000000);
    store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxEntries: 10000,
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        originPort = (originServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    proxyListener = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      clock,
      cache: {
        enabled: true,
        maxObjectBytes: 5 * 1024 * 1024,
        debugHeaders: true,
      },
    });
    proxyPort = proxyListener.httpPort!;
  });

  afterAll(async () => {
    await proxyListener.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  function makeRequest(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path,
          method: options.method ?? 'GET',
          headers: options.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            });
          });
          res.on('error', reject);
          res.on('close', () => {
            if (!res.complete) {
              reject(new Error('Premature close'));
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function getOriginStats(): Promise<{ totalRequests: number; perPath: Record<string, number> }> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${originPort}/__stats`, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(JSON.parse(text)));
        res.on('error', reject);
      });
    });
  }

  it('serves MISS on first request, then HIT for next 9 requests with 1 origin request', async () => {
    resetStats();
    store.clear();

    // 1. First request -> MISS
    const firstRes = await makeRequest('/counter');
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers['x-cache']).toBe('MISS');
    expect(firstRes.headers['x-cache-reason']).toBe('not_found');
    expect(firstRes.headers['via']).toBe('1.1 cdn-proxy');

    const expectedBody = firstRes.body;

    let originStats = await getOriginStats();
    expect(originStats.perPath['/counter']).toBe(1);

    // 2. Next 9 requests -> HIT with byte-identical bodies and origin requests unchanged at 1
    for (let i = 0; i < 9; i++) {
      const hitRes = await makeRequest('/counter');
      expect(hitRes.status).toBe(200);
      expect(hitRes.headers['x-cache']).toBe('HIT');
      expect(hitRes.headers['x-cache-reason']).toBeUndefined();
      expect(hitRes.headers['via']).toBe('1.1 cdn-proxy');
      expect(hitRes.headers['content-length']).toBe(String(expectedBody.length));
      expect(hitRes.headers['transfer-encoding']).toBeUndefined();
      expect(hitRes.headers['age']).toBe('0');
      expect(hitRes.headers['date']).toBe(firstRes.headers['date']);
      expect(hitRes.body).toBe(expectedBody); // Byte-for-byte identical
    }

    originStats = await getOriginStats();
    expect(originStats.perPath['/counter']).toBe(1);
    expect(store.stats().hits).toBe(9);
  });

  it('turns into MISS when FakeClock advances past TTL, making a 2nd origin request', async () => {
    // Current time is 1000000. Entry expires at 1000000 + 60000 = 1060000
    // Advance clock past TTL
    clock.advance(60001);

    const expiredRes = await makeRequest('/counter');
    expect(expiredRes.status).toBe(200);
    expect(expiredRes.headers['x-cache']).toBe('MISS');
    expect(expiredRes.headers['x-cache-reason']).toBe('expired');

    const originStats = await getOriginStats();
    expect(originStats.perPath['/counter']).toBe(2);
  });

  it('bypasses and reaches origin for HEAD, Range, Authorization, and Cookie', async () => {
    // 1. HEAD
    const headRes = await makeRequest('/counter', { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.headers['x-cache']).toBe('BYPASS');
    expect(headRes.headers['x-cache-reason']).toBe('method_not_cacheable');

    // 2. Range
    const rangeRes = await makeRequest('/counter', {
      headers: { Range: 'bytes=0-1' },
    });
    expect(rangeRes.status).toBe(200);
    expect(rangeRes.headers['x-cache']).toBe('BYPASS');
    expect(rangeRes.headers['x-cache-reason']).toBe('has_range');

    // 3. Authorization
    const authRes = await makeRequest('/counter', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(authRes.status).toBe(200);
    expect(authRes.headers['x-cache']).toBe('BYPASS');
    expect(authRes.headers['x-cache-reason']).toBe('has_authorization');

    // 4. Cookie
    const cookieRes = await makeRequest('/counter', {
      headers: { Cookie: 'sid=user123' },
    });
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.headers['x-cache']).toBe('BYPASS');
    expect(cookieRes.headers['x-cache-reason']).toBe('has_cookie');

    // All 4 reached the origin
    const originStats = await getOriginStats();
    // Previous count was 2 + 4 = 6
    expect(originStats.perPath['/counter']).toBe(6);
  });

  it('shares cache entry across two different query parameter orders', async () => {
    resetStats();
    store.clear();

    const url1 = '/counter?b=1&a=2';
    const url2 = '/counter?a=2&b=1';

    // First request: MISS
    const res1 = await makeRequest(url1);
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');

    // Second request with reversed query order: HIT!
    const res2 = await makeRequest(url2);
    expect(res2.status).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body).toBe(res1.body);

    const originStats = await getOriginStats();
    expect(originStats.perPath['/counter']).toBe(1);
  });

  it('does not share cache entry across two different hosts', async () => {
    resetStats();
    store.clear();

    // Request with Host: site-a.test
    const resA = await makeRequest('/counter', {
      headers: { Host: 'site-a.test' },
    });
    expect(resA.headers['x-cache']).toBe('MISS');

    // Request with Host: site-b.test
    const resB = await makeRequest('/counter', {
      headers: { Host: 'site-b.test' },
    });
    expect(resB.headers['x-cache']).toBe('MISS');

    // Origin should have received 2 requests
    const originStats = await getOriginStats();
    expect(originStats.perPath['/counter']).toBe(2);
  });

  it('leaks no sockets when client aborts mid-body during cache hit', async () => {
    // Prime cache with /large-1mb
    const prime = await makeRequest('/large-1mb');
    expect(prime.status).toBe(200);
    expect(prime.headers['x-cache']).toBe('MISS');

    // Record active sockets
    const getActiveSockets = () => (proxyListener as any).server?.connections ?? 0;
    const initialSockets = getActiveSockets();

    // Client connects and aborts mid-body during cache hit
    await new Promise<void>((resolve) => {
      const client = net.createConnection({ port: proxyPort, host: '127.0.0.1' }, () => {
        client.write('GET /large-1mb HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });

      client.on('data', () => {
        // Destroy client socket as soon as first chunk arrives
        client.destroy();
        setTimeout(resolve, 100);
      });
    });

    // Give proxy a moment to close connections
    await new Promise((r) => setTimeout(r, 100));
    const finalSockets = getActiveSockets();
    expect(finalSockets).toBeLessThanOrEqual(initialSockets);
  });

  it('completes 1,000 sequential hits of a 1 MB object without memory growth', async () => {
    // Prime cache with /large-1mb
    const prime = await makeRequest('/large-1mb');
    expect(prime.status).toBe(200);

    // Baseline memory
    if (global.gc) {
      global.gc();
    }
    const initialHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);

    for (let i = 0; i < 1000; i++) {
      await new Promise<void>((resolve, reject) => {
        http.get(`http://127.0.0.1:${proxyPort}/large-1mb`, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
          res.on('error', reject);
        });
      });
    }

    if (global.gc) {
      global.gc();
    }
    const finalHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const growthMb = finalHeapMb - initialHeapMb;
    console.log(
      `[1,000 Hits Memory Test] Start heap: ${initialHeapMb.toFixed(2)} MB, Final heap: ${finalHeapMb.toFixed(2)} MB, Delta: ${growthMb.toFixed(2)} MB`
    );

    // Assert heap stays within ~50 MB of the start
    expect(growthMb).toBeLessThan(50);
  }, 15000);
});
