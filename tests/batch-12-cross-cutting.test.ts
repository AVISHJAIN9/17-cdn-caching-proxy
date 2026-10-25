import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { PoolSelector } from '../src/config/pools.js';
import { CircuitBreaker } from '../src/health/circuit-breaker.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { FakeClock } from '../src/util/clock.js';

describe('Batch 12: Cross-cutting Integration', () => {
  let activeServers: http.Server[] = [];

  const createServer = (handler: http.RequestListener): Promise<{ server: http.Server; url: string; port: number }> => {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        activeServers.push(server);
        resolve({ server, url: `http://127.0.0.1:${addr.port}`, port: addr.port });
      });
    });
  };

  afterEach(async () => {
    await Promise.all(
      activeServers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          })
      )
    );
    activeServers = [];
  });

  it('serves stale via stale-if-error (145) when the whole origin pool is down', async () => {
    let originHits = 0;
    const origin = await createServer((req, res) => {
      originHits++;
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'max-age=1, stale-if-error=60',
      });
      res.end('cached-payload');
    });

    const clock = new FakeClock(1_000_000);
    const poolSelector = new PoolSelector();
    let poolHealthy = true;
    poolSelector.isAvailable = () => poolHealthy;

    const proxy = await createAndStartProxy({
      port: 0,
      clock,
      poolSelector,
      originsConfig: {
        origins: { o1: { url: origin.url } },
        defaultOrigin: 'o1',
        pools: {
          testPool: { members: [{ origin: 'o1' }] },
        },
        routes: [{ pathPrefix: '/sie', origin: 'testPool' }],
      },
    });

    try {
      // 1. Initial request stores entry (Cache MISS)
      const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/sie/item`);
      expect(res1.status).toBe(200);
      expect(await res1.text()).toBe('cached-payload');
      expect(originHits).toBe(1);

      // 2. Advance time past max-age (2 seconds) -> entry is stale, but within stale-if-error (60s)
      clock.advance(2_000);

      // 3. Mark the entire origin pool down!
      poolHealthy = false;

      // 4. Request should NOT fail with 502/503; it must serve stale cached representation!
      const res2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/sie/item`);
      expect(res2.status).toBe(200);
      expect(res2.headers.get('x-cache')).toBe('STALE');
      expect(res2.headers.get('warning')).toContain('110');
      expect(await res2.text()).toBe('cached-payload');

      // Origin was not hit again
      expect(originHits).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('preserves request coalescing (50) under failover so concurrent requests yield exactly 1 upstream fetch', async () => {
    let backupHits = 0;
    const backup = await createServer((req, res) => {
      backupHits++;
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
        });
        res.end('coalesced-backup-body');
      }, 30);
    });

    const poolSelector = new PoolSelector();
    // Primary is down, backup is healthy
    poolSelector.isAvailable = (id) => id === 'bak';

    const proxy = await createAndStartProxy({
      port: 0,
      poolSelector,
      originsConfig: {
        origins: {
          pri: { url: 'http://127.0.0.1:59999' }, // unreachable
          bak: { url: backup.url },
        },
        defaultOrigin: 'pri',
        pools: {
          failoverPool: {
            members: [{ origin: 'pri' }, { origin: 'bak', backup: true }],
          },
        },
        routes: [{ pathPrefix: '/coalesce', origin: 'failoverPool' }],
      },
      cache: {
        coalescing: { enabled: true },
      },
    });

    try {
      // 10 concurrent requests for the exact same cold key
      const requests = Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${proxy.httpPort}/coalesce/cold-key`).then(async (r) => ({
          status: r.status,
          body: await r.text(),
        }))
      );

      const results = await Promise.all(requests);

      // All 10 requests completed successfully with identical body
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body).toBe('coalesced-backup-body');
      }

      // Exactly 1 upstream request reached the backup!
      expect(backupHits).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('returns connection counters and pooled sockets to baseline after failures and circuit breaker trips', async () => {
    const srv = await createServer((req, res) => {
      res.writeHead(500);
      res.end('internal error');
    });

    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 60_000 });
    const poolSelector = new PoolSelector();
    poolSelector.isAvailable = (id) => breaker.allowRequest(id);

    const proxy = await createAndStartProxy({
      port: 0,
      poolSelector,
      originsConfig: {
        origins: { srv: { url: srv.url } },
        defaultOrigin: 'srv',
        pools: {
          breakerPool: { members: [{ origin: 'srv' }] },
        },
        routes: [{ pathPrefix: '/breaker', origin: 'breakerPool' }],
      },
    });

    try {
      // Send 5 requests: 3 fail with 500 and trip breaker, next 2 hit open breaker
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/breaker/test-${i}`);
        breaker.recordFailure('srv');
        expect(res.status).toBeGreaterThanOrEqual(500);
      }

      expect(breaker.getState('srv')).toBe('OPEN');

      // Active connections counter in pool selector must return to 0
      expect(poolSelector.getActiveConnections('srv')).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it('runs a seeded randomized test flipping availability under concurrent requests without hanging', async () => {
    let o1Hits = 0;
    let o2Hits = 0;

    const o1 = await createServer((req, res) => {
      o1Hits++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('o1-response');
      }, 5);
    });

    const o2 = await createServer((req, res) => {
      o2Hits++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('o2-response');
      }, 5);
    });

    // Seeded pseudo-random number generator (LCG)
    let seed = 42;
    const nextRandom = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const availability: Record<string, boolean> = { o1: true, o2: true };
    const poolSelector = new PoolSelector();
    poolSelector.isAvailable = (id) => availability[id];

    const proxy = await createAndStartProxy({
      port: 0,
      poolSelector,
      originsConfig: {
        origins: { o1: { url: o1.url }, o2: { url: o2.url } },
        defaultOrigin: 'o1',
        pools: {
          randPool: {
            loadBalancing: 'least-connections',
            members: [{ origin: 'o1' }, { origin: 'o2' }],
          },
        },
        routes: [{ pathPrefix: '/rand', origin: 'randPool' }],
      },
    });

    try {
      const concurrentCount = 20;
      const requests = Array.from({ length: concurrentCount }, async (_, idx) => {
        // Randomly toggle availability based on pseudo-random seed
        if (nextRandom() > 0.5) {
          availability.o1 = nextRandom() > 0.3;
          availability.o2 = nextRandom() > 0.3;
        }

        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/rand/${idx}`);
        // Response is either 200 (if at least one healthy) or 502 (if both down)
        expect([200, 502]).toContain(res.status);
        await res.text();
      });

      await Promise.all(requests);

      // Verify no requests hung and active connection counters return to baseline
      expect(poolSelector.getActiveConnections('o1')).toBe(0);
      expect(poolSelector.getActiveConnections('o2')).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});
