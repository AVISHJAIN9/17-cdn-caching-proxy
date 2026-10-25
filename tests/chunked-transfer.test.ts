import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 76: Chunked transfer', { timeout: 20000 }, () => {
  let originServer: http.Server;
  let proxy: ProxyListener;
  let originPort: number;
  let proxyPort: number;
  let originRequests = 0;

  beforeEach(async () => {
    originRequests = 0;

    originServer = http.createServer((req, res) => {
      originRequests++;

      if (req.url === '/chunked-stream') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        // Do not set Content-Length; write chunks
        res.write('chunk-1;');
        setTimeout(() => {
          res.write('chunk-2;');
          setTimeout(() => {
            res.end('chunk-3');
          }, 20);
        }, 20);
        return;
      }

      if (req.url === '/chunked-and-content-length') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Length', '9999'); // Deliberate mismatch / smuggling attempt
        res.write('safe-chunked-data');
        res.end();
        return;
      }

      if (req.url === '/chunked-cacheable') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.write('part-A;');
        res.write('part-B;');
        res.end('part-C');
        return;
      }

      res.statusCode = 200;
      res.end('ok');
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

  it('streams upstream chunked responses to downstream client correctly', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/chunked-stream`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('chunk-1;chunk-2;chunk-3');
    expect(originRequests).toBe(1);
  });

  it('rejects conflicting Transfer-Encoding: chunked and Content-Length with 502', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/chunked-and-content-length`);
    expect(res.status).toBe(502);
  });

  it('assembles and stores chunked cacheable response, serving cache hit with Content-Length', async () => {
    // 1. Initial request (miss -> chunks assembled and stored)
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/chunked-cacheable`);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('part-A;part-B;part-C');
    expect(originRequests).toBe(1);

    // 2. Second request (cache HIT)
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/chunked-cacheable`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(res2.headers.get('content-length')).toBe(String(Buffer.byteLength('part-A;part-B;part-C')));
    expect(await res2.text()).toBe('part-A;part-B;part-C');
    expect(originRequests).toBe(1); // Served from cache
  });
});
