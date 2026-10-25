import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  parseOriginsConfig,
  PoolSelector,
  OriginsConfig,
  resolveOriginForRequest,
} from '../src/config/origins.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 65: Load balancing', () => {
  let server1: http.Server;
  let port1: number;

  let server2: http.Server;
  let port2: number;

  let server3: http.Server;
  let port3: number;

  beforeAll(async () => {
    server1 = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-server': 'srv-1' });
      res.end(JSON.stringify({ server: 'srv-1' }));
    });
    await new Promise<void>((r) => server1.listen(0, '127.0.0.1', () => r()));
    port1 = (server1.address() as any).port;

    server2 = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-server': 'srv-2' });
      res.end(JSON.stringify({ server: 'srv-2' }));
    });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', () => r()));
    port2 = (server2.address() as any).port;

    server3 = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-server': 'srv-3' });
      res.end(JSON.stringify({ server: 'srv-3' }));
    });
    await new Promise<void>((r) => server3.listen(0, '127.0.0.1', () => r()));
    port3 = (server3.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server1.close(() => r()));
    await new Promise<void>((r) => server2.close(() => r()));
    await new Promise<void>((r) => server3.close(() => r()));
  });

  describe('Round-Robin Strategy', () => {
    it('cycles sequentially through all pool members', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'n1' }, { origin: 'n2' }, { origin: 'n3' }],
      };

      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        results.push(selector.selectMember('p1', pool)!);
      }

      expect(results).toEqual(['n1', 'n2', 'n3', 'n1', 'n2', 'n3']);
    });
  });

  describe('Least-Connections Strategy', () => {
    it('selects the origin with the lowest active connections count', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'least-connections' as const,
        members: [{ origin: 'n1' }, { origin: 'n2' }],
      };

      // Initially both have 0 connections -> picks n1
      expect(selector.selectMember('p-lc', pool)).toBe('n1');

      // Record 3 connections on n1
      selector.recordConnectionStart('n1');
      selector.recordConnectionStart('n1');
      selector.recordConnectionStart('n1');

      // Next pick should choose n2 (0 < 3)
      expect(selector.selectMember('p-lc', pool)).toBe('n2');

      // Record 4 connections on n2
      selector.recordConnectionStart('n2');
      selector.recordConnectionStart('n2');
      selector.recordConnectionStart('n2');
      selector.recordConnectionStart('n2');

      // Now n1 has 3 and n2 has 4 -> picks n1
      expect(selector.selectMember('p-lc', pool)).toBe('n1');

      // Release connections from n2
      selector.recordConnectionEnd('n2');
      selector.recordConnectionEnd('n2');
      selector.recordConnectionEnd('n2');
      // n2 now has 1 connection, n1 has 3 -> picks n2
      expect(selector.selectMember('p-lc', pool)).toBe('n2');
    });
  });

  describe('Batch 12 isAvailable Predicate Hook', () => {
    it('skips origins where isAvailable returns false', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'healthy-1' }, { origin: 'sick-2' }, { origin: 'healthy-3' }],
      };

      // Hook excludes sick-2
      selector.isAvailable = (originId: string) => originId !== 'sick-2';

      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        results.push(selector.selectMember('p-avail', pool)!);
      }

      // sick-2 must never be selected
      expect(results.includes('sick-2')).toBe(false);
      expect(results).toEqual([
        'healthy-1',
        'healthy-3',
        'healthy-1',
        'healthy-3',
        'healthy-1',
        'healthy-3',
      ]);
    });

    it('returns undefined when all origins in the pool are unavailable', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'round-robin' as const,
        members: [{ origin: 'dead-1' }, { origin: 'dead-2' }],
      };

      // Everything is unavailable
      selector.isAvailable = () => false;

      const pick = selector.selectMember('dead-pool', pool);
      expect(pick).toBeUndefined();
    });
  });

  describe('End-to-End Proxy Load Balancing with Availability Hook', () => {
    it('distributes requests in round-robin and dynamically honors isAvailable hook', async () => {
      const poolSelector = new PoolSelector();

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: {
            s1: { url: `http://127.0.0.1:${port1}` },
            s2: { url: `http://127.0.0.1:${port2}` },
            s3: { url: `http://127.0.0.1:${port3}` },
          },
          defaultOrigin: 's1',
          pools: {
            cluster: {
              loadBalancing: 'round-robin',
              members: [{ origin: 's1' }, { origin: 's2' }, { origin: 's3' }],
            },
          },
          routes: [{ pathPrefix: '/cluster', origin: 'cluster' }],
        },
      });

      try {
        const counts: Record<string, number> = { 'srv-1': 0, 'srv-2': 0, 'srv-3': 0 };

        // 9 requests across 3 servers -> exactly 3 each
        for (let i = 0; i < 9; i++) {
          const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/cluster/req-${i}`);
          expect(res.status).toBe(200);
          const data: any = await res.json();
          counts[data.server] = (counts[data.server] || 0) + 1;
        }

        expect(counts['srv-1']).toBe(3);
        expect(counts['srv-2']).toBe(3);
        expect(counts['srv-3']).toBe(3);

        // Now simulate Batch 12 health check taking down srv-2
        poolSelector.isAvailable = (id) => id !== 's2';

        const failoverCounts: Record<string, number> = { 'srv-1': 0, 'srv-2': 0, 'srv-3': 0 };
        for (let i = 0; i < 6; i++) {
          const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/cluster/failover-${i}`);
          expect(res.status).toBe(200);
          const data: any = await res.json();
          failoverCounts[data.server] = (failoverCounts[data.server] || 0) + 1;
        }

        // srv-2 must have 0 hits, while srv-1 and srv-3 receive 3 hits each
        expect(failoverCounts['srv-2']).toBe(0);
        expect(failoverCounts['srv-1']).toBe(3);
        expect(failoverCounts['srv-3']).toBe(3);
      } finally {
        await proxy.close();
      }
    });

    it('returns 502 Bad Gateway when all members in pool are unavailable', async () => {
      const poolSelector = new PoolSelector();
      // Everything marked unhealthy
      poolSelector.isAvailable = () => false;

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: {
            s1: { url: `http://127.0.0.1:${port1}` },
          },
          defaultOrigin: 's1',
          pools: {
            cluster: {
              members: [{ origin: 's1' }],
            },
          },
          routes: [{ pathPrefix: '/down', origin: 'cluster' }],
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/down/ping`);
        expect(res.status).toBe(502);
      } finally {
        await proxy.close();
      }
    });
  });
});
