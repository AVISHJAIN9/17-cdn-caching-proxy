import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  parseOriginsConfig,
  resolveOriginForRequest,
  OriginsConfig,
} from '../src/config/origins.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 55: Origin pools', () => {
  let origin1Server: http.Server;
  let origin1Port: number;

  let origin2Server: http.Server;
  let origin2Port: number;

  beforeAll(async () => {
    origin1Server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-origin-id': 'backend-1',
        date: new Date().toUTCString(),
      });
      res.end(JSON.stringify({ server: 'backend-1' }));
    });
    await new Promise<void>((r) => origin1Server.listen(0, '127.0.0.1', () => r()));
    origin1Port = (origin1Server.address() as any).port;

    origin2Server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-origin-id': 'backend-2',
        date: new Date().toUTCString(),
      });
      res.end(JSON.stringify({ server: 'backend-2' }));
    });
    await new Promise<void>((r) => origin2Server.listen(0, '127.0.0.1', () => r()));
    origin2Port = (origin2Server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => origin1Server.close(() => r()));
    await new Promise<void>((r) => origin2Server.close(() => r()));
  });

  describe('Configuration & Schema Validation', () => {
    it('validates a valid origin pool configuration', () => {
      const config = parseOriginsConfig({
        origins: {
          b1: { url: 'http://127.0.0.1:9001' },
          b2: { url: 'http://127.0.0.1:9002' },
        },
        defaultOrigin: 'b1',
        pools: {
          'app-pool': {
            members: [{ origin: 'b1' }, { origin: 'b2' }],
          },
        },
      });

      expect(config.pools?.['app-pool']).toBeDefined();
      expect(config.pools?.['app-pool'].members).toHaveLength(2);
    });

    it('rejects pool with nonexistent member origin', () => {
      expect(() => {
        parseOriginsConfig({
          origins: {
            b1: { url: 'http://127.0.0.1:9001' },
          },
          defaultOrigin: 'b1',
          pools: {
            'app-pool': {
              members: [{ origin: 'b1' }, { origin: 'nonexistent-origin' }],
            },
          },
        });
      }).toThrow(/does not exist in configured origins/);
    });

    it('rejects pool with 0 members', () => {
      expect(() => {
        parseOriginsConfig({
          origins: {
            b1: { url: 'http://127.0.0.1:9001' },
          },
          defaultOrigin: 'b1',
          pools: {
            'empty-pool': {
              members: [],
            },
          },
        });
      }).toThrow(/at least one member/i);
    });
  });

  describe('Pool Routing Resolution', () => {
    it('resolves pool target to one of its members', () => {
      const config: OriginsConfig = parseOriginsConfig({
        origins: {
          b1: { url: 'http://127.0.0.1:9001' },
          b2: { url: 'http://127.0.0.1:9002' },
        },
        defaultOrigin: 'b1',
        pools: {
          cluster: {
            members: [{ origin: 'b1' }, { origin: 'b2' }],
          },
        },
        routes: [{ pathPrefix: '/cluster', origin: 'cluster' }],
      });

      const selected = resolveOriginForRequest({ url: '/cluster/api', headers: {} }, config);
      expect(['b1', 'b2']).toContain(selected);
    });
  });

  describe('End-to-End Proxy Routing with Pools', () => {
    it('distributes incoming traffic across pool member origins', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            b1: { url: `http://127.0.0.1:${origin1Port}` },
            b2: { url: `http://127.0.0.1:${origin2Port}` },
          },
          defaultOrigin: 'b1',
          pools: {
            appPool: {
              members: [{ origin: 'b1' }, { origin: 'b2' }],
            },
          },
          routes: [{ pathPrefix: '/pool', origin: 'appPool' }],
        },
      });

      try {
        const hits: Record<string, number> = { 'backend-1': 0, 'backend-2': 0 };

        for (let i = 0; i < 6; i++) {
          const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/pool/req-${i}`);
          expect(res.status).toBe(200);
          const data: any = await res.json();
          hits[data.server] = (hits[data.server] || 0) + 1;
        }

        // Both servers in the pool should have received traffic
        expect(hits['backend-1']).toBeGreaterThan(0);
        expect(hits['backend-2']).toBeGreaterThan(0);
        expect(hits['backend-1'] + hits['backend-2']).toBe(6);
      } finally {
        await proxy.close();
      }
    });
  });
});
