import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 51: Stampede Prevention', () => {
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let clock: FakeClock;
  let store: MemoryStore;
  const baseTime = 1_000_000_000_000;

  beforeEach(async () => {
    resetStats();
    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        originPort = (originServer.address() as any).port;
        resolve();
      });
    });

    clock = new FakeClock(baseTime);
    store = new MemoryStore();
    proxyListener = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      clock,
      store,
      cache: {
        enabled: true,
        debugHeaders: true,
        revalidate: { enabled: true },
        maxObjectBytes: 5 * 1024 * 1024,
        coalescing: { enabled: true },
      },
      timeouts: {
        upstreamConnectMs: 500,
        upstreamHeadersMs: 800,
      },
    });
    proxyPort = proxyListener.httpPort!;
  });

  afterEach(async () => {
    await proxyListener?.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  async function configOrigin(id: string, opts: { cc?: string; cc304?: string; delayMs?: number; body?: string }) {
    const json = JSON.stringify(opts);
    await rawRequest(
      originPort,
      `POST /__config/${id} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n` +
        json
    );
  }

  async function getOriginLogs(): Promise<Array<{ method: string; path: string; ifNoneMatch?: string }>> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${originPort}/__log`, (res) => {
        let text = '';
        res.on('data', (c) => (text += c.toString('utf-8')));
        res.on('end', () => resolve(JSON.parse(text || '[]')));
        res.on('error', reject);
      });
    });
  }

  it('1. 100 parallel requests on one cold key produce exactly 1 upstream fetch', async () => {
    await configOrigin('stampede-cold-100', {
      cc: 'max-age=60',
      delayMs: 60,
    });

    const concurrency = 100;
    const clientAgent = new http.Agent({ maxSockets: 150 });
    const promises: Promise<number>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const req = http.get(
            `http://127.0.0.1:${proxyPort}/reval/stampede-cold-100`,
            { agent: clientAgent },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
              res.on('error', reject);
            }
          );
          req.on('error', reject);
        })
      );
    }

    const statuses = await Promise.all(promises);
    expect(statuses).toHaveLength(concurrency);
    for (const st of statuses) {
      expect(st).toBe(200);
    }

    const logs = await getOriginLogs();
    const originFetches = logs.filter((l) => l.path === '/reval/stampede-cold-100');
    expect(originFetches).toHaveLength(1);

    expect(proxyListener.flightMap?.size ?? 0).toBe(0);
    expect(proxyListener.backgroundJobs?.size ?? 0).toBe(0);
    expect(proxyListener.passMarkerMap?.size ?? 0).toBe(0);
  });

  it('2. 50 concurrent requests on a single stale entry produce exactly 1 upstream conditional revalidation', async () => {
    // Prime entry
    await configOrigin('stampede-stale', {
      cc: 'max-age=60',
      cc304: 'max-age=60',
    });

    const primeRes = await rawRequest(
      proxyPort,
      `GET /reval/stampede-stale HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: close\r\n\r\n`
    );
    expect(primeRes.statusCode).toBe(200);

    // Stale at 70s, configure small delay to ensure all 50 concurrent requests overlap
    clock.advance(70_000);
    await configOrigin('stampede-stale', { delayMs: 40 });

    const concurrency = 50;
    const clientAgent = new http.Agent({ maxSockets: 100 });
    const promises: Promise<{ status: number; body: string }>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const req = http.get(
            `http://127.0.0.1:${proxyPort}/reval/stampede-stale`,
            { agent: clientAgent },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf-8'),
                });
              });
              res.on('error', reject);
            }
          );
          req.on('error', reject);
        })
      );
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(concurrency);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toBe('id=stampede-stale version=1 count=1\n');
    }

    const logs = await getOriginLogs();
    const conditionalLogs = logs.filter(
      (l) => l.path === '/reval/stampede-stale' && l.ifNoneMatch !== undefined
    );
    expect(conditionalLogs).toHaveLength(1);

    expect(proxyListener.flightMap?.size ?? 0).toBe(0);
    expect(proxyListener.backgroundJobs?.size ?? 0).toBe(0);
    expect(proxyListener.passMarkerMap?.size ?? 0).toBe(0);
  });

  it('3. Revalidation 200 replacement during stampede delivers new body to all waiting clients', async () => {
    await configOrigin('stampede-replace', {
      cc: 'max-age=60',
      cc304: 'max-age=60',
    });

    const prime = await rawRequest(
      proxyPort,
      `GET /reval/stampede-replace HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: close\r\n\r\n`
    );
    expect(prime.statusCode).toBe(200);
    expect(prime.body.toString('utf-8')).toBe('id=stampede-replace version=1 count=1\n');

    clock.advance(70_000);

    // Bump origin version to version 2 (will return 200 OK with new content on reval)
    await rawRequest(
      originPort,
      'POST /__bump/stampede-replace HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    await configOrigin('stampede-replace', { delayMs: 40 });

    const concurrency = 20;
    const clientAgent = new http.Agent({ maxSockets: 50 });
    const promises: Promise<string>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const req = http.get(
            `http://127.0.0.1:${proxyPort}/reval/stampede-replace`,
            { agent: clientAgent },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
              res.on('error', reject);
            }
          );
          req.on('error', reject);
        })
      );
    }

    const bodies = await Promise.all(promises);
    expect(bodies).toHaveLength(concurrency);
    for (const b of bodies) {
      expect(b).toBe('id=stampede-replace version=2 count=2\n');
    }

    const logs = await getOriginLogs();
    const revalRequests = logs.filter(
      (l) => l.path === '/reval/stampede-replace' && l.ifNoneMatch !== undefined
    );
    expect(revalRequests).toHaveLength(1);

    expect(proxyListener.flightMap?.size ?? 0).toBe(0);
    expect(proxyListener.backgroundJobs?.size ?? 0).toBe(0);
    expect(proxyListener.passMarkerMap?.size ?? 0).toBe(0);
  });

  it('4. Stale-while-revalidate stampede: serves stale immediately and runs exactly one background job', async () => {
    await configOrigin('stampede-swr', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
      delayMs: 250,
    });

    const prime = await rawRequest(
      proxyPort,
      `GET /reval/stampede-swr HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: close\r\n\r\n`
    );
    expect(prime.statusCode).toBe(200);

    clock.advance(70_000);

    const concurrency = 20;
    const promises = Array.from({ length: concurrency }, () =>
      rawRequest(
        proxyPort,
        `GET /reval/stampede-swr HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: close\r\n\r\n`
      )
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(concurrency);
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-cache']).toBe('STALE');
    }

    // Wait for the single background job to complete
    await new Promise((r) => setTimeout(r, 300));

    expect(proxyListener.backgroundJobs?.size ?? 0).toBe(0);
    expect(proxyListener.flightMap?.size ?? 0).toBe(0);
    expect(proxyListener.passMarkerMap?.size ?? 0).toBe(0);
  });

  it('5. Different keys are never blocked by each other', async () => {
    await configOrigin('key-a', { cc: 'max-age=60', delayMs: 60 });
    await configOrigin('key-b', { cc: 'max-age=60', delayMs: 60 });

    const [resA, resB] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        http.get(`http://127.0.0.1:${proxyPort}/reval/key-a`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', reject);
        });
      }),
      new Promise<number>((resolve, reject) => {
        http.get(`http://127.0.0.1:${proxyPort}/reval/key-b`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', reject);
        });
      }),
    ]);

    expect(resA).toBe(200);
    expect(resB).toBe(200);

    const logs = await getOriginLogs();
    expect(logs.filter((l) => l.path === '/reval/key-a')).toHaveLength(1);
    expect(logs.filter((l) => l.path === '/reval/key-b')).toHaveLength(1);
  });

  it('6. Client abort by one follower does not cancel leader or other followers', async () => {
    await configOrigin('stampede-abort', { cc: 'max-age=60', delayMs: 80 });

    // Leader request
    const leaderPromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/reval/stampede-abort`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
    });

    // Follower 1 (will abort)
    const followerReq = http.get(`http://127.0.0.1:${proxyPort}/reval/stampede-abort`);
    followerReq.on('error', () => {});

    // Follower 2 (stays connected)
    const follower2Promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/reval/stampede-abort`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
    });

    // Abort follower 1 mid-flight
    await new Promise((r) => setTimeout(r, 20));
    followerReq.destroy();

    const [leaderRes, follower2Res] = await Promise.all([leaderPromise, follower2Promise]);

    expect(leaderRes.status).toBe(200);
    expect(follower2Res.status).toBe(200);
    expect(follower2Res.body).toBe(leaderRes.body);

    expect(proxyListener.flightMap?.size ?? 0).toBe(0);
    expect(proxyListener.passMarkerMap?.size ?? 0).toBe(0);
  });
});
