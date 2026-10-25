import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 50: Request Coalescing', () => {
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
        upstreamHeadersMs: 400,
      },
    });
    proxyPort = proxyListener.httpPort!;
  });

  afterEach(async () => {
    await proxyListener?.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  async function configOrigin(id: string, patch: Record<string, any>): Promise<void> {
    const body = JSON.stringify(patch);
    await rawRequest(
      originPort,
      `POST /__config/${id} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  }

  async function getOriginLogs(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${originPort}/__log`, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(JSON.parse(text || '[]')));
        res.on('error', reject);
      });
    });
  }

  it('1. N parallel requests for the same cold key produce exactly 1 upstream fetch', async () => {
    // Configure endpoint with a small delay so all 50 concurrent requests overlap
    await configOrigin('cold-item', {
      cc: 'max-age=60',
      delayMs: 50,
    });

    const concurrency = 50;
    const clientAgent = new http.Agent({ maxSockets: 100 });
    const promises: Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const req = http.get(
            `http://127.0.0.1:${proxyPort}/reval/cold-item`,
            { agent: clientAgent },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf-8'),
                  headers: res.headers,
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

    // All clients received 200 OK with the exact body (count=1 confirms coalescing to 1 fetch)
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toBe('id=cold-item version=1 count=1\n');
    }

    // Verify origin received exactly 1 fetch
    const logs = await getOriginLogs();
    const originFetches = logs.filter((l) => l.path === '/reval/cold-item');
    expect(originFetches).toHaveLength(1);

    // In-flight map is completely clean
    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);
  });

  it('2. A failed leader request propagates correctly to the waiting followers', async () => {
    // Configure endpoint to fail with 500
    await configOrigin('fail-item', {
      status: 500,
      delayMs: 50,
    });

    const concurrency = 10;
    const clientAgent = new http.Agent({ maxSockets: 20 });
    const promises: Promise<number>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const req = http.get(
            `http://127.0.0.1:${proxyPort}/reval/fail-item`,
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
      expect(st).toBe(500);
    }

    // Origin received exactly 1 fetch
    const logs = await getOriginLogs();
    const originFetches = logs.filter((l) => l.path === '/reval/fail-item');
    expect(originFetches).toHaveLength(1);

    // Inflight map is empty
    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);
  });

  it('3. Inflight map entries are cleaned up on success, failure, and timeout', async () => {
    // 3a. Success
    await configOrigin('clean-success', { cc: 'max-age=60', delayMs: 20 });
    const p1 = Promise.all([
      rawRequest(proxyPort, 'GET /reval/clean-success HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
      rawRequest(proxyPort, 'GET /reval/clean-success HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
    ]);
    const r1 = await p1;
    expect(r1[0].statusCode).toBe(200);
    expect(r1[1].statusCode).toBe(200);
    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);

    // 3b. Failure (500)
    await configOrigin('clean-fail', { status: 500, delayMs: 20 });
    const p2 = Promise.all([
      rawRequest(proxyPort, 'GET /reval/clean-fail HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
      rawRequest(proxyPort, 'GET /reval/clean-fail HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
    ]);
    const r2 = await p2;
    expect(r2[0].statusCode).toBe(500);
    expect(r2[1].statusCode).toBe(500);
    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);

    // 3c. Upstream timeout (delay > upstreamHeadersMs of 400ms)
    await configOrigin('clean-timeout', { delayMs: 600 });
    const p3 = Promise.all([
      rawRequest(proxyPort, 'GET /reval/clean-timeout HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
      rawRequest(proxyPort, 'GET /reval/clean-timeout HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
    ]);
    const r3 = await p3;
    expect(r3[0].statusCode).toBe(504);
    expect(r3[1].statusCode).toBe(504);
    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);
  });

  it('4. Follower abort does not break the leader or other followers', async () => {
    await configOrigin('abort-item', { cc: 'max-age=60', delayMs: 60, body: 'safe-body' });

    // Client 1: Leader
    const leaderPromise = rawRequest(
      proxyPort,
      'GET /reval/abort-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // Small delay to ensure leader is in flight
    await new Promise((r) => setTimeout(r, 10));

    // Client 2: Follower that aborts socket prematurely
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write('GET /reval/abort-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      setTimeout(() => {
        socket.destroy(); // Abort mid-flight
      }, 15);
    });

    // Client 3: Follower that stays connected
    const followerPromise = rawRequest(
      proxyPort,
      'GET /reval/abort-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    const [leaderRes, followerRes] = await Promise.all([leaderPromise, followerPromise]);
    expect(leaderRes.statusCode).toBe(200);
    expect(leaderRes.body.toString('utf-8')).toBe('id=abort-item version=1 count=1\n');
    expect(followerRes.statusCode).toBe(200);
    expect(followerRes.body.toString('utf-8')).toBe('id=abort-item version=1 count=1\n');

    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);
  });

  it('5. Non-storable responses propagate to followers and clean up flightMap and passMarkers', async () => {
    await configOrigin('nostore-item', {
      cc: 'no-store',
      delayMs: 30,
    });

    const p = Promise.all([
      rawRequest(proxyPort, 'GET /reval/nostore-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
      rawRequest(proxyPort, 'GET /reval/nostore-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
    ]);

    const [r1, r2] = await p;
    expect(r1.statusCode).toBe(200);
    expect(r1.body.toString('utf-8')).toBe('id=nostore-item version=1 count=1\n');
    expect(r2.statusCode).toBe(200);
    expect(r2.body.toString('utf-8')).toBe('id=nostore-item version=1 count=1\n');

    expect((proxyListener as any).flightMap?.size ?? 0).toBe(0);
    expect((proxyListener as any).passMarkerMap?.size ?? 0).toBe(0);
  });
});
