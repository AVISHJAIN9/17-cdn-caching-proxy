import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { PoolSelector } from '../src/config/pools.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 57: Health routing', () => {
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

  describe('Pool Selection with Health State', () => {
    it('skips unhealthy origins in round-robin policy', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'o1' }, { origin: 'o2' }, { origin: 'o3' }],
      };

      const availability: Record<string, boolean> = { o1: true, o2: false, o3: true };
      selector.isAvailable = (id) => availability[id] ?? true;

      const picks = [
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
      ];

      expect(picks).toEqual(['o1', 'o3', 'o1', 'o3']);
    });

    it('skips unhealthy origins in least-connections policy', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'least-connections' as const,
        members: [{ origin: 'o1' }, { origin: 'o2' }, { origin: 'o3' }],
      };

      // o1 has 5 connections, o2 has 1 connection, o3 has 3 connections
      for (let i = 0; i < 5; i++) selector.recordConnectionStart('o1');
      selector.recordConnectionStart('o2');
      for (let i = 0; i < 3; i++) selector.recordConnectionStart('o3');

      // If o2 is healthy, it would be picked (1 conn). But o2 is unhealthy!
      selector.isAvailable = (id) => id !== 'o2';

      // Out of healthy o1 (5) and o3 (3), o3 must be picked
      expect(selector.selectMember('p1', pool)).toBe('o3');
    });

    it('preserves exact weight proportions among remaining healthy origins in weighted policy', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'weighted' as const,
        members: [
          { origin: 'o1', weight: 3 },
          { origin: 'o2', weight: 1 },
          { origin: 'o3', weight: 2 },
        ],
      };

      // o3 is unhealthy; remaining healthy are o1 (weight 3) and o2 (weight 1) -> 3:1 ratio
      selector.isAvailable = (id) => id !== 'o3';

      const counts: Record<string, number> = { o1: 0, o2: 0, o3: 0 };
      for (let i = 0; i < 40; i++) {
        const picked = selector.selectMember('p1', pool);
        if (picked) counts[picked]++;
      }

      expect(counts['o3']).toBe(0);
      expect(counts['o1']).toBe(30);
      expect(counts['o2']).toBe(10);
    });

    it('allows a recovered origin to rejoin routing seamlessly', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'o1' }, { origin: 'o2' }],
      };

      let o2Healthy = false;
      selector.isAvailable = (id) => (id === 'o2' ? o2Healthy : true);

      // Initially only o1 is available
      expect(selector.selectMember('p1', pool)).toBe('o1');
      expect(selector.selectMember('p1', pool)).toBe('o1');

      // o2 recovers!
      o2Healthy = true;
      const picks = [
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
      ];

      expect(picks.filter((p) => p === 'o1').length).toBe(2);
      expect(picks.filter((p) => p === 'o2').length).toBe(2);
    });

    it('returns undefined when all origins in the pool are unhealthy', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'o1' }, { origin: 'o2' }],
      };

      selector.isAvailable = () => false;
      expect(selector.selectMember('p1', pool)).toBeUndefined();
    });
  });

  describe('End-to-End Proxy Health Routing', () => {
    it('routes requests to healthy origins, skips unhealthy ones, and handles in-flight completion', async () => {
      let s1Hits = 0;
      let s2Hits = 0;

      const s1 = await createServer((req, res) => {
        s1Hits++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('from-s1');
      });

      let s2ReceivedResolve!: () => void;
      let s2ReceivedPromise = new Promise<void>((r) => {
        s2ReceivedResolve = r;
      });

      const s2 = await createServer((req, res) => {
        s2Hits++;
        s2ReceivedResolve();
        // Delayed response to test in-flight completion
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('from-s2');
        }, 40);
      });

      const poolSelector = new PoolSelector();
      let s2Available = true;
      poolSelector.isAvailable = (id) => (id === 's2' ? s2Available : true);

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: {
            s1: { url: s1.url },
            s2: { url: s2.url },
          },
          defaultOrigin: 's1',
          pools: {
            appCluster: {
              loadBalancing: 'round-robin',
              members: [{ origin: 's1' }, { origin: 's2' }],
            },
          },
          routes: [{ pathPrefix: '/app', origin: 'appCluster' }],
        },
      });

      try {
        // First request goes to s1
        const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/app/1`);
        expect(res1.status).toBe(200);
        expect(await res1.text()).toBe('from-s1');

        // Start request to s2 (which will hit s2 and be delayed 40ms)
        const inFlightReqToS2 = fetch(`http://127.0.0.1:${proxy.httpPort}/app/2`);

        // Wait until request has actually reached s2
        await s2ReceivedPromise;

        // While request is in-flight on s2, mark s2 unhealthy!
        s2Available = false;

        // In-flight request to s2 must still finish cleanly without throwing
        const res2 = await inFlightReqToS2;
        expect(res2.status).toBe(200);
        expect(await res2.text()).toBe('from-s2');

        // Subsequent requests must now skip s2 and go only to s1
        const res3 = await fetch(`http://127.0.0.1:${proxy.httpPort}/app/3`);
        expect(res3.status).toBe(200);
        expect(await res3.text()).toBe('from-s1');

        const res4 = await fetch(`http://127.0.0.1:${proxy.httpPort}/app/4`);
        expect(res4.status).toBe(200);
        expect(await res4.text()).toBe('from-s1');

        expect(s1Hits).toBe(3);
        expect(s2Hits).toBe(1);

        // Active connection counters must be back to 0
        expect(poolSelector.getActiveConnections('s1')).toBe(0);
        expect(poolSelector.getActiveConnections('s2')).toBe(0);
      } finally {
        await proxy.close();
      }
    });

    it('returns defined 502 Bad Gateway when all origins in the pool are unhealthy', async () => {
      const s1 = await createServer((req, res) => {
        res.writeHead(200);
        res.end('ok');
      });

      const poolSelector = new PoolSelector();
      poolSelector.isAvailable = () => false;

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: {
            s1: { url: s1.url },
          },
          defaultOrigin: 's1',
          pools: {
            downCluster: {
              members: [{ origin: 's1' }],
            },
          },
          routes: [{ pathPrefix: '/down', origin: 'downCluster' }],
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/down/test`);
        expect(res.status).toBe(502);
      } finally {
        await proxy.close();
      }
    });
  });
});
