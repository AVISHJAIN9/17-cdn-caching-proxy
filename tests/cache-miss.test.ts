import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';

describe('Feature 4: Cache miss (src/cache/fill.ts)', () => {
  let originServer: http.Server;
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;
  let clock: FakeClock;

  let originCounters: Record<string, number> = {};
  let totalOriginRequests = 0;

  beforeAll(async () => {
    clock = new FakeClock(1000000);
    store = new MemoryStore({
      maxObjectBytes: 1024 * 1024, // 1 MB
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });

    originServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      totalOriginRequests++;
      originCounters[url.pathname] = (originCounters[url.pathname] || 0) + 1;

      if (url.pathname === '/counter') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(String(val)).toString(),
          'Cache-Control': 'max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-private') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'private, max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-nostore') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store, max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-nocache') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache, max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-cookie') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'sid=1',
          'Cache-Control': 'max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-vary') {
        const val = originCounters[url.pathname];
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          Vary: 'Accept-Language',
          'Cache-Control': 'max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/counter-404') {
        const val = originCounters[url.pathname];
        res.writeHead(404, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=60',
        });
        res.end(String(val));
        return;
      }

      if (url.pathname === '/abort-midbody') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked',
        });
        res.write('part1');
        setTimeout(() => {
          res.destroy();
        }, 30);
        return;
      }

      if (url.pathname === '/cl-mismatch') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '100', // promised 100 bytes
          'Connection': 'close',
        });
        res.write('only 20 bytes here!');
        setTimeout(() => {
          res.socket?.destroy();
        }, 30);
        return;
      }

      if (url.pathname === '/slow-stream') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked',
        });
        res.write('chunk-1\n');
        const interval = setInterval(() => {
          if (!res.destroyed) {
            res.write('chunk-more\n');
          }
        }, 50);
        req.on('close', () => {
          clearInterval(interval);
        });
        return;
      }

      if (url.pathname === '/large-50mb') {
        // Stream 50 MB in 50 chunks of 1 MB
        const chunkSize = 1024 * 1024;
        const totalChunks = 50;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': (chunkSize * totalChunks).toString(),
        });

        const chunkBuf = Buffer.alloc(chunkSize, 'A');
        let chunksSent = 0;

        const writeNext = () => {
          while (chunksSent < totalChunks) {
            chunksSent++;
            const ok = res.write(chunkBuf);
            if (!ok) {
              res.once('drain', writeNext);
              return;
            }
          }
          res.end();
        };
        writeNext();
        return;
      }

      if (url.pathname === '/stampede-target') {
        // delay to ensure all concurrent client requests are in-flight before first response completes
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('stampede-ok');
        }, 200);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
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
        maxObjectBytes: 1024 * 1024, // 1 MB
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
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
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
              body: Buffer.concat(chunks).toString(),
            });
          });
          res.on('error', reject);
          res.on('close', () => {
            if (!res.complete) {
              reject(new Error('Premature response close'));
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('stores response on miss when all storability rules hold', async () => {
    store.clear();
    const res = await makeRequest('/counter');
    expect(res.status).toBe(200);
    expect(res.body).toBe('1');
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers['x-cache-reason']).toBe('not_found');

    const stats = store.stats();
    expect(stats.stores).toBe(1);
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBe(1);
  });

  it('rejects storing when response status is not 200 (/counter-404)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-404');
    expect(res.status).toBe(404);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Set-Cookie header is present (/counter-cookie)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-cookie');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Vary header is present (/counter-vary)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-vary');
    expect(res.status).toBe(200);
    expect(res.headers['vary']).toBe('Accept-Language');
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Cache-Control contains private (/counter-private)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-private');
    expect(res.status).toBe(200);
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Cache-Control contains no-store (/counter-nostore)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-nostore');
    expect(res.status).toBe(200);
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Cache-Control contains no-cache (/counter-nocache)', async () => {
    const prevStores = store.stats().stores;
    const res = await makeRequest('/counter-nocache');
    expect(res.status).toBe(200);
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when origin aborts mid-body (/abort-midbody)', async () => {
    const prevStores = store.stats().stores;
    await expect(makeRequest('/abort-midbody')).rejects.toThrow();
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when Content-Length does not match received bytes', async () => {
    const prevStores = store.stats().stores;
    await expect(makeRequest('/cl-mismatch')).rejects.toThrow();
    // Received only 20 bytes when 100 was promised, socket truncated
    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when client aborts before origin finishes', async () => {
    const prevStores = store.stats().stores;

    await new Promise<void>((resolve) => {
      const client = net.createConnection({ port: proxyPort, host: '127.0.0.1' }, () => {
        client.write('GET /slow-stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });

      client.on('data', () => {
        // Client aborts as soon as first chunk arrives
        client.destroy();
        setTimeout(resolve, 100);
      });
    });

    expect(store.stats().stores).toBe(prevStores);
  });

  it('rejects storing when store capacity limit is reached without evicting (cache_full)', async () => {
    const tinyStore = new MemoryStore({
      maxObjectBytes: 1024,
      maxTotalBytes: 50, // Only 50 bytes total capacity
      maxEntries: 2,
    });

    const localProxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store: tinyStore,
      clock,
      cache: { enabled: true },
    });
    const localPort = localProxy.httpPort!;

    try {
      // First request (small body) stores ok
      const r1 = await new Promise<{ status: number }>((resolve) => {
        http.get(`http://127.0.0.1:${localPort}/counter`, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
      });
      expect(r1.status).toBe(200);
      expect(tinyStore.stats().stores).toBe(1);

      // Artificially fill store to capacity
      tinyStore.set({
        keyHash: 'fake-hash-1',
        keyString: 'fake-1',
        originId: 'default',
        status: 200,
        statusMessage: 'OK',
        headers: {},
        body: Buffer.alloc(45),
        size: 45,
        storedAt: clock.now(),
        requestTimeMs: clock.now() - 50,
        responseTimeMs: clock.now(),
        dateValueMs: clock.now(),
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        lifetimeSource: 'max-age',
        hitCount: 0,
        lastAccessedAt: clock.now(),
      });
      expect(tinyStore.stats().entries).toBe(2);

      // Another request comes in: client receives response, but store skips storing (no eviction)
      const r2 = await new Promise<{ status: number }>((resolve) => {
        http.get(`http://127.0.0.1:${localPort}/counter?new=1`, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
      });
      expect(r2.status).toBe(200);
      expect(tinyStore.stats().storeSkipped).toBeGreaterThan(0);
      expect(tinyStore.stats().entries).toBe(2); // Still 2 entries, nothing evicted!
    } finally {
      await localProxy.stop();
    }
  });

  it('streams 50 MB response to client with bounded memory when maxObjectBytes is 1 MB', async () => {
    store.clear();
    const prevStores = store.stats().stores;

    const initialMem = process.memoryUsage().heapUsed;

    const res = await new Promise<{ status: number; bytesReceived: number }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/large-50mb`, (res) => {
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, bytesReceived: total });
        });
        res.on('error', reject);
      });
    });

    const expected50MB = 50 * 1024 * 1024;
    expect(res.status).toBe(200);
    expect(res.bytesReceived).toBe(expected50MB);
    // Nothing was stored
    expect(store.stats().stores).toBe(prevStores);
    expect(store.stats().entries).toBe(0);

    const afterMem = process.memoryUsage().heapUsed;
    const diffMb = (afterMem - initialMem) / (1024 * 1024);
    console.log(`[50MB Test] Process memory delta: ${diffMb.toFixed(2)} MB`);
    // Memory growth must stay well bounded (far below 50 MB)
    expect(diffMb).toBeLessThan(35);
  });

  it('records baseline measurement for concurrent misses (stampede behavior)', async () => {
    const targetPath = '/stampede-target';
    const initialOriginCount = originCounters[targetPath] || 0;

    // Fire 50 concurrent requests for an uncached URL
    const concurrency = 50;
    const promises: Promise<string>[] = [];

    const clientAgent = new http.Agent({ maxSockets: 100 });
    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise<string>((resolve, reject) => {
          http.get(
            `http://127.0.0.1:${proxyPort}${targetPath}`,
            { agent: clientAgent },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks).toString()));
              res.on('error', reject);
            }
          );
        })
      );
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(concurrency);
    for (const body of results) {
      expect(body).toBe('stampede-ok');
    }

    const finalOriginCount = originCounters[targetPath] || 0;
    const originRequestsOccurred = finalOriginCount - initialOriginCount;
    console.log(
      `[Stampede Baseline] Concurrent requests: ${concurrency}, Origin requests occurred: ${originRequestsOccurred}`
    );
    expect(originRequestsOccurred).toBeGreaterThanOrEqual(40);
  });
});
