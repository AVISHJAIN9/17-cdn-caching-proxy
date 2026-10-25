import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 77: Content-length validation', { timeout: 20000 }, () => {
  let originServer: http.Server;
  let proxy: ProxyListener;
  let originPort: number;
  let proxyPort: number;
  let originRequests = 0;
  let store: MemoryStore;

  beforeEach(async () => {
    originRequests = 0;

    originServer = http.createServer((req, res) => {
      originRequests++;

      if (req.url === '/exact-length') {
        const body = 'exact-32-byte-content-abcdefgh';
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(body).toString(),
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(body);
        return;
      }

      if (req.url === '/underrun-body') {
        // Promises 100 bytes but sends only 20 bytes then closes
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '100',
          'Cache-Control': 'public, max-age=3600',
        });
        res.write('short 20-byte payload');
        setTimeout(() => {
          res.socket?.destroy();
        }, 30);
        return;
      }

      if (req.url === '/overrun-body') {
        // Raw HTTP server response sending 40 bytes when only 15 were promised
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '15',
          'Cache-Control': 'public, max-age=3600',
        });
        // Write 15 bytes
        res.write('fifteen bytes!!');
        // Now attempt smuggling overrun with extra 25 bytes
        res.write('ATTEMPTING_EXTRA_OVERRUN_BYTES');
        res.end();
        return;
      }

      res.statusCode = 200;
      res.end('default');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as AddressInfo).port;

    store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      cache: {
        enabled: true,
        debugHeaders: true,
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

  it('validates exact Content-Length matching and successfully caches and serves object', async () => {
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/exact-length`);
    expect(res1.status).toBe(200);
    const body1 = await res1.text();
    expect(body1).toBe('exact-32-byte-content-abcdefgh');
    expect(res1.headers.get('content-length')).toBe('30');
    expect(originRequests).toBe(1);

    // Second request is a cache HIT
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/exact-length`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(res2.headers.get('content-length')).toBe('30');
    expect(await res2.text()).toBe('exact-32-byte-content-abcdefgh');
    expect(originRequests).toBe(1);
  });

  it('handles premature EOF / underrun by dropping partial data without caching', async () => {
    const initialStores = store.stats().stores;

    // Direct HTTP request to observe connection failure / socket reset
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${proxyPort}/underrun-body`, (res) => {
          res.on('data', () => {});
          res.on('error', reject);
          res.on('close', () => {
            if (!res.complete) {
              reject(new Error('Premature socket close'));
            } else {
              resolve();
            }
          });
          res.on('end', () => {
            if (!res.complete) {
              reject(new Error('Premature socket close'));
            } else {
              resolve();
            }
          });
        });
        req.on('error', reject);
      })
    ).rejects.toThrow();

    // Incomplete payload was not stored in cache
    expect(store.stats().stores).toBe(initialStores);
    expect(store.stats().entries).toBe(0);
  });

  it('detects overrun smuggling guard and aborts without caching corrupt data', async () => {
    const initialStores = store.stats().stores;

    // Upstream sends 45 bytes for declared Content-Length of 15
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${proxyPort}/overrun-body`, (res) => {
          res.on('data', () => {});
          res.on('error', reject);
          res.on('close', () => {
            if (!res.complete) {
              reject(new Error('Response aborted by proxy on overrun'));
            } else {
              resolve();
            }
          });
          res.on('end', () => {
            if (!res.complete) {
              reject(new Error('Response aborted by proxy on overrun'));
            } else {
              resolve();
            }
          });
        });
        req.on('error', reject);
      })
    ).rejects.toThrow();

    // Corrupt overrun response was rejected and never stored
    expect(store.stats().stores).toBe(initialStores);
    expect(store.stats().entries).toBe(0);
  });
});
