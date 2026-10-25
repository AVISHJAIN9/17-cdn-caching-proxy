import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  parseOriginsConfig,
  PoolSelector,
  OriginsConfig,
  resolveOriginForRequest,
} from '../src/config/origins.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 56: Weighted routing', () => {
  let originAServer: http.Server;
  let originAPort: number;

  let originBServer: http.Server;
  let originBPort: number;

  let originCServer: http.Server;
  let originCPort: number;

  beforeAll(async () => {
    originAServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'origin-a' });
      res.end(JSON.stringify({ origin: 'origin-a' }));
    });
    await new Promise<void>((r) => originAServer.listen(0, '127.0.0.1', () => r()));
    originAPort = (originAServer.address() as any).port;

    originBServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'origin-b' });
      res.end(JSON.stringify({ origin: 'origin-b' }));
    });
    await new Promise<void>((r) => originBServer.listen(0, '127.0.0.1', () => r()));
    originBPort = (originBServer.address() as any).port;

    originCServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'origin-c' });
      res.end(JSON.stringify({ origin: 'origin-c' }));
    });
    await new Promise<void>((r) => originCServer.listen(0, '127.0.0.1', () => r()));
    originCPort = (originCServer.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => originAServer.close(() => r()));
    await new Promise<void>((r) => originBServer.close(() => r()));
    await new Promise<void>((r) => originCServer.close(() => r()));
  });

  describe('Configuration & Weight Validation', () => {
    it('accepts valid integer weights', () => {
      const config = parseOriginsConfig({
        origins: {
          a: { url: 'http://127.0.0.1:9001' },
          b: { url: 'http://127.0.0.1:9002' },
        },
        defaultOrigin: 'a',
        pools: {
          'weighted-pool': {
            loadBalancing: 'weighted',
            members: [
              { origin: 'a', weight: 3 },
              { origin: 'b', weight: 1 },
            ],
          },
        },
      });

      expect(config.pools?.['weighted-pool'].members[0].weight).toBe(3);
      expect(config.pools?.['weighted-pool'].members[1].weight).toBe(1);
    });

    it('rejects non-positive weights (zero or negative)', () => {
      expect(() => {
        parseOriginsConfig({
          origins: { a: { url: 'http://127.0.0.1:9001' } },
          defaultOrigin: 'a',
          pools: {
            p: {
              members: [{ origin: 'a', weight: 0 }],
            },
          },
        });
      }).toThrow();

      expect(() => {
        parseOriginsConfig({
          origins: { a: { url: 'http://127.0.0.1:9001' } },
          defaultOrigin: 'a',
          pools: {
            p: {
              members: [{ origin: 'a', weight: -2 }],
            },
          },
        });
      }).toThrow();
    });

    it('rejects non-integer weights', () => {
      expect(() => {
        parseOriginsConfig({
          origins: { a: { url: 'http://127.0.0.1:9001' } },
          defaultOrigin: 'a',
          pools: {
            p: {
              members: [{ origin: 'a', weight: 2.5 }],
            },
          },
        });
      }).toThrow();
    });
  });

  describe('Weighted Distribution Logic', () => {
    it('distributes requests in exact 3:1 ratio over 40 iterations', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'weighted' as const,
        members: [
          { origin: 'node-a', weight: 3 },
          { origin: 'node-b', weight: 1 },
        ],
      };

      const counts: Record<string, number> = { 'node-a': 0, 'node-b': 0 };
      for (let i = 0; i < 40; i++) {
        const picked = selector.selectMember('test-pool', pool);
        counts[picked!] = (counts[picked!] || 0) + 1;
      }

      expect(counts['node-a']).toBe(30);
      expect(counts['node-b']).toBe(10);
    });

    it('distributes requests in exact 1:2:1 ratio over 40 iterations', () => {
      const selector = new PoolSelector();
      const pool = {
        loadBalancing: 'weighted' as const,
        members: [
          { origin: 'node-a', weight: 1 },
          { origin: 'node-b', weight: 2 },
          { origin: 'node-c', weight: 1 },
        ],
      };

      const counts: Record<string, number> = { 'node-a': 0, 'node-b': 0, 'node-c': 0 };
      for (let i = 0; i < 40; i++) {
        const picked = selector.selectMember('three-pool', pool);
        counts[picked!] = (counts[picked!] || 0) + 1;
      }

      expect(counts['node-a']).toBe(10);
      expect(counts['node-b']).toBe(20);
      expect(counts['node-c']).toBe(10);
    });
  });

  describe('End-to-End Proxy Weighted Routing', () => {
    it('routes requests to origins in exact 3:1 proportion', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            origA: { url: `http://127.0.0.1:${originAPort}` },
            origB: { url: `http://127.0.0.1:${originBPort}` },
          },
          defaultOrigin: 'origA',
          pools: {
            weightedPool: {
              loadBalancing: 'weighted',
              members: [
                { origin: 'origA', weight: 3 },
                { origin: 'origB', weight: 1 },
              ],
            },
          },
          routes: [{ pathPrefix: '/weighted', origin: 'weightedPool' }],
        },
      });

      try {
        const counts: Record<string, number> = { 'origin-a': 0, 'origin-b': 0 };
        for (let i = 0; i < 40; i++) {
          const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/weighted/req-${i}`);
          expect(res.status).toBe(200);
          const data: any = await res.json();
          counts[data.origin] = (counts[data.origin] || 0) + 1;
        }

        expect(counts['origin-a']).toBe(30);
        expect(counts['origin-b']).toBe(10);
      } finally {
        await proxy.close();
      }
    });
  });
});
