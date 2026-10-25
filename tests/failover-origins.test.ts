import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { PoolSelector } from '../src/config/pools.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { shouldRetryOnStaleSocket } from '../src/proxy/upstream.js';

describe('Feature 58: Failover origins', () => {
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

  describe('Pool Selector Failover Logic', () => {
    it('uses backups only when no primary is available', () => {
      const selector = new PoolSelector();
      const pool = {
        members: [
          { origin: 'primary-1' },
          { origin: 'primary-2' },
          { origin: 'backup-1', backup: true },
        ],
      };

      const availability: Record<string, boolean> = {
        'primary-1': true,
        'primary-2': true,
        'backup-1': true,
      };
      selector.isAvailable = (id) => availability[id] ?? true;

      // While primaries are healthy, backup-1 is never selected
      const selections = [
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
        selector.selectMember('p1', pool),
      ];
      expect(selections).not.toContain('backup-1');

      // Primary 1 fails, but Primary 2 is still healthy -> backup still not used
      availability['primary-1'] = false;
      expect(selector.selectMember('p1', pool)).toBe('primary-2');

      // Both primaries fail -> failover to backup
      availability['primary-2'] = false;
      expect(selector.selectMember('p1', pool)).toBe('backup-1');
    });

    it('returns traffic to primary immediately upon recovery', () => {
      const selector = new PoolSelector();
      const pool = {
        members: [
          { origin: 'primary-1' },
          { origin: 'backup-1', backup: true },
        ],
      };

      const availability: Record<string, boolean> = {
        'primary-1': false,
        'backup-1': true,
      };
      selector.isAvailable = (id) => availability[id] ?? true;

      // Primary is down -> selects backup
      expect(selector.selectMember('p1', pool)).toBe('backup-1');

      // Primary recovers!
      availability['primary-1'] = true;
      expect(selector.selectMember('p1', pool)).toBe('primary-1');
    });

    it('respects backup ordering when multiple backups exist', () => {
      const selector = new PoolSelector();
      const pool = {
        members: [
          { origin: 'primary-1' },
          { origin: 'backup-1', backup: true },
          { origin: 'backup-2', backup: true },
        ],
      };

      const availability: Record<string, boolean> = {
        'primary-1': false,
        'backup-1': true,
        'backup-2': true,
      };
      selector.isAvailable = (id) => availability[id] ?? true;

      // Primary is down -> backup-1 is chosen (first in backup order)
      expect(selector.selectMember('p1', pool)).toBe('backup-1');

      // Backup 1 fails -> backup-2 is chosen
      availability['backup-1'] = false;
      expect(selector.selectMember('p1', pool)).toBe('backup-2');
    });

    it('returns undefined when no healthy primary and no healthy backup exist', () => {
      const selector = new PoolSelector();
      const pool = {
        members: [
          { origin: 'primary-1' },
          { origin: 'backup-1', backup: true },
        ],
      };

      selector.isAvailable = () => false;
      expect(selector.selectMember('p1', pool)).toBeUndefined();
    });
  });

  describe('End-to-End Proxy Failover, Cache Key Invariance, and Retry Rules', () => {
    it('fails over to backup seamlessly and verifies cache key invariance across primary and backup', async () => {
      let primaryHits = 0;
      let backupHits = 0;

      const primary = await createServer((req, res) => {
        primaryHits++;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        });
        res.end(JSON.stringify({ origin: 'primary', data: 'content' }));
      });

      const backup = await createServer((req, res) => {
        backupHits++;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        });
        res.end(JSON.stringify({ origin: 'backup', data: 'content' }));
      });

      const poolSelector = new PoolSelector();
      let primaryHealthy = true;
      poolSelector.isAvailable = (id) => (id === 'pri' ? primaryHealthy : true);

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: {
            pri: { url: primary.url },
            bak: { url: backup.url },
          },
          defaultOrigin: 'pri',
          pools: {
            servicePool: {
              members: [
                { origin: 'pri' },
                { origin: 'bak', backup: true },
              ],
            },
          },
          routes: [{ pathPrefix: '/service', origin: 'servicePool' }],
        },
      });

      try {
        // 1. Initial request hits primary
        const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/service/item-1`);
        expect(res1.status).toBe(200);
        expect((await res1.json()).origin).toBe('primary');
        expect(primaryHits).toBe(1);
        expect(backupHits).toBe(0);

        // 2. Primary goes down
        primaryHealthy = false;

        // 3. Request to an uncached URL (/service/item-2) routes to backup
        const res2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/service/item-2`);
        expect(res2.status).toBe(200);
        expect((await res2.json()).origin).toBe('backup');
        expect(primaryHits).toBe(1);
        expect(backupHits).toBe(1);

        // 4. Request to the first URL (/service/item-1) must be served from CACHE (HIT)
        // proving the cache key was invariant and not poisoned or keyed by the origin ID
        const resCached = await fetch(`http://127.0.0.1:${proxy.httpPort}/service/item-1`);
        expect(resCached.status).toBe(200);
        expect(resCached.headers.get('x-cache')).toBe('HIT');
        expect((await resCached.json()).origin).toBe('primary');
        // Neither origin received another request
        expect(primaryHits).toBe(1);
        expect(backupHits).toBe(1);
      } finally {
        await proxy.close();
      }
    });

    it('enforces retry rule: idempotent GET on stale socket is retried, but POST is never retried', () => {
      const err = new Error('socket hang up');
      (err as any).code = 'ECONNRESET';

      // Safe idempotent GET on reused socket with no body written -> retry allowed
      expect(shouldRetryOnStaleSocket(err, 'GET', true, false)).toBe(true);
      expect(shouldRetryOnStaleSocket(err, 'HEAD', true, false)).toBe(true);
      expect(shouldRetryOnStaleSocket(err, 'OPTIONS', true, false)).toBe(true);

      // Non-idempotent POST -> NEVER retried
      expect(shouldRetryOnStaleSocket(err, 'POST', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(err, 'POST', false, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(err, 'POST', true, true)).toBe(false);
    });
  });
});
