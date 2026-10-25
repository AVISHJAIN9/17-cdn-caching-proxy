import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { DnsCache } from '../src/dns/cache.js';
import { FakeClock } from '../src/util/clock.js';
import { UpstreamClient } from '../src/proxy/upstream.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 63: DNS caching', () => {
  let originServer: http.Server;
  let originPort: number;

  beforeAll(async () => {
    originServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', source: 'dns-origin' }));
    });
    await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', () => r()));
    originPort = (originServer.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => originServer.close(() => r()));
  });

  describe('DnsCache Unit Operations', () => {
    it('caches DNS resolution and reports hit/miss statistics', async () => {
      let resolverInvocations = 0;
      const clock = new FakeClock(1000);
      const dnsCache = new DnsCache({
        ttlMs: 60000,
        clock,
        resolver: async (hostname: string) => {
          resolverInvocations++;
          if (hostname === 'origin.local') {
            return { address: '127.0.0.1', family: 4 };
          }
          throw new Error('ENOTFOUND');
        },
      });

      // 1st lookup -> Cache MISS
      const res1 = await new Promise<string>((resolve, reject) => {
        dnsCache.lookup('origin.local', {}, (err, address) => {
          if (err) reject(err);
          else resolve(address as string);
        });
      });
      expect(res1).toBe('127.0.0.1');
      expect(resolverInvocations).toBe(1);
      expect(dnsCache.getStats()).toEqual({ hits: 0, misses: 1, size: 1 });

      // 2nd lookup -> Cache HIT
      const res2 = await new Promise<string>((resolve, reject) => {
        dnsCache.lookup('origin.local', {}, (err, address) => {
          if (err) reject(err);
          else resolve(address as string);
        });
      });
      expect(res2).toBe('127.0.0.1');
      expect(resolverInvocations).toBe(1); // not called again
      expect(dnsCache.getStats()).toEqual({ hits: 1, misses: 1, size: 1 });
    });

    it('expires cached DNS records when TTL passes', async () => {
      let resolverInvocations = 0;
      const clock = new FakeClock(1000);
      const dnsCache = new DnsCache({
        ttlMs: 5000,
        clock,
        resolver: async () => {
          resolverInvocations++;
          return { address: '127.0.0.1', family: 4 };
        },
      });

      // Lookup at t=1000
      await new Promise<void>((resolve) => {
        dnsCache.lookup('api.local', {}, () => resolve());
      });
      expect(resolverInvocations).toBe(1);

      // Advance clock past TTL (t=7000)
      clock.advance(6000);

      // Subsequent lookup should re-resolve
      await new Promise<void>((resolve) => {
        dnsCache.lookup('api.local', {}, () => resolve());
      });
      expect(resolverInvocations).toBe(2);
      expect(dnsCache.getStats().misses).toBe(2);
    });

    it('supports options.all returning array of address objects', async () => {
      const dnsCache = new DnsCache({
        ttlMs: 30000,
        resolver: async () => ({ address: '127.0.0.1', family: 4 }),
      });

      const addresses = await new Promise<any[]>((resolve, reject) => {
        dnsCache.lookup('multi.local', { all: true }, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs as any[]);
        });
      });

      expect(Array.isArray(addresses)).toBe(true);
      expect(addresses[0]).toEqual({ address: '127.0.0.1', family: 4 });
    });

    it('propagates resolver error on resolution failure', async () => {
      const dnsCache = new DnsCache({
        resolver: async () => {
          const err: any = new Error('getaddrinfo ENOTFOUND invalid.host');
          err.code = 'ENOTFOUND';
          throw err;
        },
      });

      await expect(
        new Promise((resolve, reject) => {
          dnsCache.lookup('invalid.host', {}, (err, addr) => {
            if (err) reject(err);
            else resolve(addr);
          });
        })
      ).rejects.toThrow('ENOTFOUND');
    });
  });

  describe('Integration with Upstream Client and Proxy', () => {
    it('uses DnsCache lookup in UpstreamClient to resolve origin requests', async () => {
      const dnsCache = new DnsCache({
        ttlMs: 60000,
        resolver: async (host) => {
          if (host === 'custom-backend.internal') {
            return { address: '127.0.0.1', family: 4 };
          }
          throw new Error('ENOTFOUND');
        },
      });

      const client = new UpstreamClient();
      const targetUrl = new URL(`http://custom-backend.internal:${originPort}/test`);

      const res = await new Promise<string>((resolve, reject) => {
        client.request(
          {
            url: targetUrl,
            method: 'GET',
            headers: { host: `custom-backend.internal:${originPort}` },
            lookup: dnsCache.lookup.bind(dnsCache),
          },
          (originRes) => {
            let data = '';
            originRes.on('data', (c) => (data += c));
            originRes.on('end', () => resolve(data));
          },
          reject
        );
      });

      const parsed = JSON.parse(res);
      expect(parsed.source).toBe('dns-origin');
      expect(dnsCache.getStats().misses).toBe(1);

      client.destroy();
    });

    it('configures DnsCache in proxy and caches DNS lookups across requests', async () => {
      let resolverCount = 0;
      const dnsCache = new DnsCache({
        ttlMs: 60000,
        resolver: async () => {
          resolverCount++;
          return { address: '127.0.0.1', family: 4 };
        },
      });

      const proxy = await createAndStartProxy({
        port: 0,
        dnsCache,
        originsConfig: {
          origins: {
            default: {
              url: `http://virtual-origin.test:${originPort}`,
            },
          },
          defaultOrigin: 'default',
        },
      });

      try {
        // Request 1
        const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/req-1`);
        expect(res1.status).toBe(200);

        // Subsequent lookup on the same hostname hits DNS cache
        await new Promise<void>((resolve) => {
          dnsCache.lookup('virtual-origin.test', {}, () => resolve());
        });

        // DNS should have been resolved once by origin probe, then served from DnsCache
        expect(dnsCache.getStats().hits).toBeGreaterThanOrEqual(1);
        expect(resolverCount).toBe(1);
      } finally {
        await proxy.close();
      }
    });
  });
});
