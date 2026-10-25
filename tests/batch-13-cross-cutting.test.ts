import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { decompressBuffer } from '../src/compression/codecs.js';

describe('Batch 13: Cross-cutting Integration', () => {
  let originServer: http.Server;
  let originPort: number;
  let proxy: any;
  let store: MemoryStore;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (originServer) {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  it('Batch 6/7: evaluates If-None-Match on dynamically encoded variant giving correct 304 and weakened validator', async () => {
    originServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        ETag: '"strong-etag-123"',
        'Cache-Control': 'public, max-age=300',
      });
      res.end('Compressible content for conditional tests '.repeat(50));
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as any).port;

    store = new MemoryStore({ maxTotalBytes: 10 * 1024 * 1024 });
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    const proxyPort = proxy.httpPort!;

    // First request: Cache MISS -> stored in canonical form -> dynamic gzip compression
    const res1 = await makeRawRequest(proxyPort, 'GET', '/cond', { 'Accept-Encoding': 'gzip' });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['content-encoding']).toBe('gzip');
    // Strong ETag weakened per RFC 9110 on dynamic transformation
    expect(res1.headers['etag']).toBe('W/"strong-etag-123"');

    // Second request: Client sends conditional request with the weakened ETag
    const res2 = await makeRawRequest(proxyPort, 'GET', '/cond', {
      'Accept-Encoding': 'gzip',
      'If-None-Match': 'W/"strong-etag-123"',
    });
    expect(res2.statusCode).toBe(304);
    expect(res2.body.length).toBe(0); // 304 must not transmit body
    expect(res2.headers['etag']).toBe('W/"strong-etag-123"');

    // Third request: Client sends strong ETag representation, weak comparison matches per RFC 9110
    const res3 = await makeRawRequest(proxyPort, 'GET', '/cond', {
      'Accept-Encoding': 'gzip',
      'If-None-Match': '"strong-etag-123"',
    });
    expect(res3.statusCode).toBe(304);
    expect(res3.body.length).toBe(0);
  });

  it('Batch 8: request coalescing across varied client Accept-Encoding values produces 1 upstream fetch', async () => {
    let originFetches = 0;
    const originalText = 'Coalesced shared text content across codecs '.repeat(100);

    originServer = http.createServer((_req, res) => {
      originFetches++;
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(originalText);
      }, 50);
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as any).port;

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      cache: { coalesce: true },
    });
    const proxyPort = proxy.httpPort!;

    // Send 3 concurrent requests with different Accept-Encoding headers:
    // Request 1: gzip
    // Request 2: br
    // Request 3: identity
    const p1 = makeRawRequest(proxyPort, 'GET', '/coalesced-doc', { 'Accept-Encoding': 'gzip' });
    const p2 = makeRawRequest(proxyPort, 'GET', '/coalesced-doc', { 'Accept-Encoding': 'br' });
    const p3 = makeRawRequest(proxyPort, 'GET', '/coalesced-doc', { 'Accept-Encoding': 'identity' });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(originFetches).toBe(1);

    // Verify client 1 got gzip and it decodes to originalText
    expect(r1.headers['content-encoding']).toBe('gzip');
    const decompGzip = zlib.gunzipSync(r1.body).toString('utf-8');
    expect(decompGzip).toBe(originalText);

    // Verify client 2 got br and it decodes to originalText
    expect(r2.headers['content-encoding']).toBe('br');
    const decompBr = zlib.brotliDecompressSync(r2.body).toString('utf-8');
    expect(decompBr).toBe(originalText);

    // Verify client 3 got identity without content-encoding
    expect(r3.headers['content-encoding']).toBeUndefined();
    expect(r3.body.toString('utf-8')).toBe(originalText);
  });

  it('Batch 9/10: canonical storage guarantees exact byte accounting regardless of client encodings', async () => {
    const rawBody = 'Exact byte accounting fixture data '.repeat(40);
    const expectedByteSize = Buffer.byteLength(rawBody);

    originServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(rawBody);
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as any).port;

    store = new MemoryStore({ maxTotalBytes: 50 * 1024 });
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    const proxyPort = proxy.httpPort!;

    // Fetch as gzip
    await makeRawRequest(proxyPort, 'GET', '/byte-exact', { 'Accept-Encoding': 'gzip' });
    const statsAfterGzip = store.stats();
    expect(statsAfterGzip.totalBytes).toBe(expectedByteSize);

    // Fetch as br (cache hit)
    await makeRawRequest(proxyPort, 'GET', '/byte-exact', { 'Accept-Encoding': 'br' });
    const statsAfterBr = store.stats();
    // Cache size does not inflate or duplicate variants
    expect(statsAfterBr.totalBytes).toBe(expectedByteSize);
    expect(statsAfterBr.entries).toBe(1);
  });

  it('Seeded randomized concurrency test with varied Accept-Encoding and client aborts', async () => {
    let seed = 987654321;
    function nextRandom(): number {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    const testPayload = 'Randomized concurrent encoding payload item '.repeat(100);

    originServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(testPayload);
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as any).port;

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
    });
    const proxyPort = proxy.httpPort!;

    const encodingsList = [
      'gzip',
      'br',
      'zstd',
      'identity',
      'gzip, br;q=0.8',
      'br;q=1.0, gzip;q=0.5',
      'deflate, identity;q=1.0',
    ];

    const tasks = Array.from({ length: 25 }, async (_, i) => {
      const selectedEnc = encodingsList[Math.floor(nextRandom() * encodingsList.length)];
      const shouldAbort = nextRandom() < 0.2; // 20% abort rate

      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxyPort,
            path: `/rand-${i % 5}`, // 5 shared URLs to test cache hits
            method: 'GET',
            headers: { 'Accept-Encoding': selectedEnc },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => {
              chunks.push(c);
              if (shouldAbort) {
                // Abort connection mid-body
                req.destroy();
                resolve();
              }
            });
            res.on('end', async () => {
              if (shouldAbort) {
                resolve();
                return;
              }
              const body = Buffer.concat(chunks);
              const ce = res.headers['content-encoding'];

              try {
                let decoded = '';
                if (ce === 'gzip') {
                  decoded = zlib.gunzipSync(body).toString('utf-8');
                } else if (ce === 'br') {
                  decoded = zlib.brotliDecompressSync(body).toString('utf-8');
                } else if (ce === 'zstd') {
                  const decomp = await decompressBuffer(body, 'zstd');
                  decoded = decomp.toString('utf-8');
                } else {
                  decoded = body.toString('utf-8');
                }

                expect(decoded).toBe(testPayload);
                resolve();
              } catch (err) {
                reject(err);
              }
            });
            res.on('error', () => {
              resolve();
            });
          }
        );
        req.on('error', () => {
          resolve();
        });
        req.end();
      });
    });

    await Promise.all(tasks);
  });
});

function makeRawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
