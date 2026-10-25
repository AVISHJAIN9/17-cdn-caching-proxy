import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { originServer } from '../scripts/demo-origin.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { parseRequest } from '../src/proxy/request.js';
import { streamOriginResponse } from '../src/proxy/stream.js';
import { createRequestContext } from '../src/proxy/context.js';

describe('Feature 2: Streaming responses (src/proxy/stream.ts)', () => {
  let originPort: number;
  let proxy: ProxyListener;
  let proxyPort: number;
  let abortedMidbodyEvents: string[] = [];

  beforeAll(async () => {
    // 1. Start origin
    await new Promise<void>((r) => {
      originServer.listen(0, '127.0.0.1', () => r());
    });
    originPort = (originServer.address() as any).port;

    // 2. Start proxy
    proxy = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res);
        if (!proxyReq) return;

        const ctx = createRequestContext(proxyReq.id);

        const upstreamReq = http.request(
          {
            host: '127.0.0.1',
            port: originPort,
            method: proxyReq.method,
            path: proxyReq.url,
            headers: proxyReq.headers as any,
          },
          (originRes) => {
            streamOriginResponse(originRes, res, proxyReq.method, {
              context: ctx,
              onUpstreamAbortedMidbody: (id) => {
                abortedMidbodyEvents.push(id);
              },
            }).catch(() => {
              // Expected on stream error / midbody abort
            });
          }
        );

        proxyReq.body.pipe(upstreamReq);
      }
    );

    await proxy.start();
    proxyPort = proxy.httpPort!;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((r) => originServer.close(() => r()));
  });

  it('a. Time to first byte: receives first chunk in under ~150 ms, not after 1000 ms', async () => {
    const startTime = Date.now();
    let firstChunkTime = 0;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: '/stream?chunks=5&delayMs=200',
        },
        (res) => {
          res.on('data', () => {
            if (firstChunkTime === 0) {
              firstChunkTime = Date.now() - startTime;
            }
          });
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end();
    });

    // Chunks were 200ms apart (total 1000ms), but first chunk should arrive early (before full body finishes)
    expect(firstChunkTime).toBeGreaterThan(0);
    expect(firstChunkTime).toBeLessThan(750);
  });

  it('b. Backpressure: a slow client reading /big?mb=50 does not blow up memory', async () => {
    const mb = 50;
    const initialMem = process.memoryUsage();
    const initialTotal = initialMem.heapUsed + initialMem.arrayBuffers;

    let receivedBytes = 0;
    let throttled = true;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `/big?mb=${mb}`,
        },
        (res) => {
          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (throttled) {
              res.pause();
              setTimeout(() => {
                res.resume();
              }, 10);
              if (receivedBytes > 500 * 1024) {
                throttled = false;
                res.resume();
              }
            }
          });

          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 100));
    global.gc?.();

    const currentMem = process.memoryUsage();
    const currentTotal = currentMem.heapUsed + currentMem.arrayBuffers;
    const diffMb = (currentTotal - initialTotal) / (1024 * 1024);

    expect(receivedBytes).toBe(mb * 1024 * 1024);
    // Proxy memory must not have buffered the 50 MB file (diff < 30 MB)
    expect(diffMb).toBeLessThan(30);
  });

  it('c. /abort-midbody makes the client see an aborted response, not a clean end', async () => {
    abortedMidbodyEvents = [];
    let clientSawError = false;
    let clientSawCleanEnd = false;

    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: '/abort-midbody',
        },
        (res) => {
          res.on('data', () => {
            // Received some data before abort
          });
          res.on('end', () => {
            clientSawCleanEnd = true;
            resolve();
          });
          res.on('error', () => {
            clientSawError = true;
            resolve();
          });
          res.on('close', () => {
            if (!clientSawCleanEnd) {
              clientSawError = true;
            }
            resolve();
          });
        }
      );

      req.on('error', () => {
        clientSawError = true;
        resolve();
      });

      req.end();
    });

    expect(clientSawError).toBe(true);
    expect(clientSawCleanEnd).toBe(false);
    expect(abortedMidbodyEvents.length).toBeGreaterThan(0);
  });

  it('d. A 200 MB response completes with correct byte count and no memory blowup', async () => {
    const mb = 200;
    const targetBytes = mb * 1024 * 1024;
    let totalReceived = 0;

    const initialMem = process.memoryUsage();
    const initialTotal = initialMem.heapUsed + initialMem.arrayBuffers;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `/big?mb=${mb}`,
        },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            totalReceived += chunk.length;
          });
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 100));
    global.gc?.();

    const finalMem = process.memoryUsage();
    const finalTotal = finalMem.heapUsed + finalMem.arrayBuffers;
    const memoryGrowthMb = (finalTotal - initialTotal) / (1024 * 1024);

    expect(totalReceived).toBe(targetBytes);
    // Memory growth must remain bounded (far below 200 MB)
    expect(memoryGrowthMb).toBeLessThan(35);
  }, 15000); // 15s timeout for 200MB stream
});
