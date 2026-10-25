import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../src/cache/memory-store.js';
import { DiskStore } from '../src/cache/disk-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { generateCacheKey } from '../src/cache/key.js';

function makeEntry(opts: {
  urlPath: string;
  namespace: string;
  bodyText: string;
  now?: number;
}): CacheEntry {
  const now = opts.now ?? Date.now();
  const { keyString, keyHash } = generateCacheKey({
    host: 'example.com',
    normalizedPath: opts.urlPath,
    normalizedQuery: '',
    method: 'GET',
    originId: 'origin-1',
    namespace: opts.namespace,
  });
  const body = Buffer.from(opts.bodyText, 'utf-8');

  return {
    keyHash,
    keyString,
    originId: 'origin-1',
    namespace: opts.namespace,
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain' },
    body,
    size: body.length,
    storedAt: now,
    lastAccessedAt: now,
    hitCount: 1,
    requestTimeMs: now,
    responseTimeMs: now + 5,
    dateValueMs: now,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 3600000,
    lifetimeSource: 'heuristic',
  };
}

describe('Feature 38: Tenant quotas', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-tenant-quota-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('Isolated tenant eviction in MemoryStore', () => {
    it('tenant A over quota evicts only tenant A entries; tenant B is untouched', () => {
      const store = new MemoryStore({
        maxTotalBytes: 100000,
        maxEntries: 100,
        tenantQuotas: {
          'tenant-a': { maxTotalBytes: 300 }, // fits two 100-byte objects, 3rd will evict
          'tenant-b': { maxTotalBytes: 1000 },
        },
      });

      const a1 = makeEntry({ urlPath: '/a1', namespace: 'tenant-a', bodyText: 'A'.repeat(100), now: 1000 });
      const a2 = makeEntry({ urlPath: '/a2', namespace: 'tenant-a', bodyText: 'A'.repeat(100), now: 2000 });
      const b1 = makeEntry({ urlPath: '/b1', namespace: 'tenant-b', bodyText: 'B'.repeat(100), now: 1500 });

      expect(store.set(a1)).toBe(true);
      expect(store.set(b1)).toBe(true);
      expect(store.set(a2)).toBe(true);

      const statsA = store.getTenantStats('tenant-a');
      const statsB = store.getTenantStats('tenant-b');
      expect(statsA.totalBytes).toBe(200);
      expect(statsA.entries).toBe(2);
      expect(statsB.totalBytes).toBe(100);
      expect(statsB.entries).toBe(1);

      // Now insert a3 into tenant-a (150 bytes). Total would be 350 > 300.
      // Must evict a1 (oldest in tenant-a). b1 in tenant-b MUST NOT be evicted.
      const a3 = makeEntry({ urlPath: '/a3', namespace: 'tenant-a', bodyText: 'A'.repeat(150), now: 3000 });
      expect(store.set(a3)).toBe(true);

      expect(store.get(a1.keyHash)).toBeUndefined(); // a1 evicted
      expect(store.get(a2.keyHash)).toBeDefined();   // a2 remains
      expect(store.get(a3.keyHash)).toBeDefined();   // a3 stored
      expect(store.get(b1.keyHash)).toBeDefined();   // b1 completely untouched!

      const updatedA = store.getTenantStats('tenant-a');
      expect(updatedA.totalBytes).toBe(250); // 100 + 150
      expect(updatedA.entries).toBe(2);
      const updatedB = store.getTenantStats('tenant-b');
      expect(updatedB.totalBytes).toBe(100);
      expect(updatedB.entries).toBe(1);
    });

    it('enforces tenant quota on entry count', () => {
      const store = new MemoryStore({
        tenantQuotas: {
          'tenant-entries': { maxEntries: 2 },
        },
      });

      const e1 = makeEntry({ urlPath: '/e1', namespace: 'tenant-entries', bodyText: 'one', now: 1000 });
      const e2 = makeEntry({ urlPath: '/e2', namespace: 'tenant-entries', bodyText: 'two', now: 2000 });
      const e3 = makeEntry({ urlPath: '/e3', namespace: 'tenant-entries', bodyText: 'three', now: 3000 });

      expect(store.set(e1)).toBe(true);
      expect(store.set(e2)).toBe(true);
      expect(store.getTenantStats('tenant-entries').entries).toBe(2);

      // 3rd entry triggers entry count eviction of e1
      expect(store.set(e3)).toBe(true);
      expect(store.get(e1.keyHash)).toBeUndefined();
      expect(store.get(e2.keyHash)).toBeDefined();
      expect(store.get(e3.keyHash)).toBeDefined();
      expect(store.getTenantStats('tenant-entries').entries).toBe(2);
    });

    it('rejects an object larger than the tenant whole quota cleanly', () => {
      const store = new MemoryStore({
        tenantQuotas: {
          'small-tenant': { maxTotalBytes: 200 },
        },
      });

      const e1 = makeEntry({ urlPath: '/e1', namespace: 'small-tenant', bodyText: 'small', now: 1000 });
      expect(store.set(e1)).toBe(true);

      // Oversized object for this tenant (300 B > 200 B)
      const oversized = makeEntry({ urlPath: '/oversized', namespace: 'small-tenant', bodyText: 'X'.repeat(300), now: 2000 });
      expect(store.set(oversized)).toBe(false);

      // Existing entry was NOT evicted to try to make room
      expect(store.get(e1.keyHash)).toBeDefined();
      expect(store.getTenantStats('small-tenant').totalBytes).toBe(e1.size);
      expect(store.getTenantStats('small-tenant').entries).toBe(1);
    });
  });

  describe('Isolated tenant eviction and persistence in DiskStore', () => {
    it('tenant A over quota evicts only tenant A entries on disk; tenant B untouched', () => {
      const store = new DiskStore({
        dirPath: tempDir,
        tenantQuotas: {
          'tenant-alpha': { maxTotalBytes: 300 },
          'tenant-beta': { maxTotalBytes: 1000 },
        },
      });

      const a1 = makeEntry({ urlPath: '/a1', namespace: 'tenant-alpha', bodyText: 'A'.repeat(100), now: 1000 });
      const a2 = makeEntry({ urlPath: '/a2', namespace: 'tenant-alpha', bodyText: 'A'.repeat(100), now: 2000 });
      const b1 = makeEntry({ urlPath: '/b1', namespace: 'tenant-beta', bodyText: 'B'.repeat(100), now: 1500 });

      expect(store.set(a1)).toBe(true);
      expect(store.set(b1)).toBe(true);
      expect(store.set(a2)).toBe(true);

      const a3 = makeEntry({ urlPath: '/a3', namespace: 'tenant-alpha', bodyText: 'A'.repeat(150), now: 3000 });
      expect(store.set(a3)).toBe(true);

      // Check cache lookups
      expect(store.get(a1.keyHash)).toBeUndefined();
      expect(store.get(a2.keyHash)).toBeDefined();
      expect(store.get(a3.keyHash)).toBeDefined();
      expect(store.get(b1.keyHash)).toBeDefined();

      // Check physical disk files
      expect(fs.existsSync(store.getFilePath(a1.keyHash))).toBe(false);
      expect(fs.existsSync(store.getFilePath(a2.keyHash))).toBe(true);
      expect(fs.existsSync(store.getFilePath(a3.keyHash))).toBe(true);
      expect(fs.existsSync(store.getFilePath(b1.keyHash))).toBe(true);
    });

    it('quota accounting stays exact across overwrite, delete, eviction and restart', () => {
      const store1 = new DiskStore({
        dirPath: tempDir,
        tenantQuotas: {
          'tenant-acc': { maxTotalBytes: 500, maxEntries: 5 },
        },
      });

      // 1. Initial insert
      const e1 = makeEntry({ urlPath: '/e1', namespace: 'tenant-acc', bodyText: 'A'.repeat(100), now: 1000 });
      expect(store1.set(e1)).toBe(true);
      expect(store1.getTenantStats('tenant-acc')).toEqual({ totalBytes: 100, entries: 1 });

      // 2. Overwrite with larger size
      const e1Updated = makeEntry({ urlPath: '/e1', namespace: 'tenant-acc', bodyText: 'A'.repeat(180), now: 2000 });
      expect(store1.set(e1Updated)).toBe(true);
      expect(store1.getTenantStats('tenant-acc')).toEqual({ totalBytes: 180, entries: 1 });

      // 3. Add second entry
      const e2 = makeEntry({ urlPath: '/e2', namespace: 'tenant-acc', bodyText: 'B'.repeat(120), now: 3000 });
      expect(store1.set(e2)).toBe(true);
      expect(store1.getTenantStats('tenant-acc')).toEqual({ totalBytes: 300, entries: 2 });

      // 4. Delete e1
      expect(store1.delete(e1.keyHash)).toBe(true);
      expect(store1.getTenantStats('tenant-acc')).toEqual({ totalBytes: 120, entries: 1 });

      // 5. Add e3 and e4
      const e3 = makeEntry({ urlPath: '/e3', namespace: 'tenant-acc', bodyText: 'C'.repeat(150), now: 4000 });
      const e4 = makeEntry({ urlPath: '/e4', namespace: 'tenant-acc', bodyText: 'D'.repeat(150), now: 5000 });
      expect(store1.set(e3)).toBe(true);
      expect(store1.set(e4)).toBe(true);
      expect(store1.getTenantStats('tenant-acc')).toEqual({ totalBytes: 420, entries: 3 });

      // 6. Restart store in same directory and verify index and quotas are preserved
      const store2 = new DiskStore({
        dirPath: tempDir,
        tenantQuotas: {
          'tenant-acc': { maxTotalBytes: 500, maxEntries: 5 },
        },
      });

      const recoveredStats = store2.getTenantStats('tenant-acc');
      expect(recoveredStats).toEqual({ totalBytes: 420, entries: 3 });
      expect(store2.get(e2.keyHash)?.body.toString('utf-8')).toBe('B'.repeat(120));
      expect(store2.get(e3.keyHash)?.body.toString('utf-8')).toBe('C'.repeat(150));
      expect(store2.get(e4.keyHash)?.body.toString('utf-8')).toBe('D'.repeat(150));

      // 7. Enforce quota on the restored store: adding 150 B exceeds 500 B (420 + 150 = 570)
      // Must evict e2 (oldest) leaving 420 - 120 + 150 = 450 B
      const e5 = makeEntry({ urlPath: '/e5', namespace: 'tenant-acc', bodyText: 'E'.repeat(150), now: 6000 });
      expect(store2.set(e5)).toBe(true);
      expect(store2.get(e2.keyHash)).toBeUndefined();
      expect(store2.get(e5.keyHash)).toBeDefined();
      expect(store2.getTenantStats('tenant-acc')).toEqual({ totalBytes: 450, entries: 3 });
    });
  });

  describe('Cross-cutting: Seeded randomized stress test with disk persistence', () => {
    it('maintains strict consistency between disk files, metadata index, and tenant accounting', () => {
      // Seeded Linear Congruential Generator (LCG)
      let seed = 42;
      function nextRandom(): number {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      let currentStore = new DiskStore({
        dirPath: tempDir,
        maxTotalBytes: 5000,
        maxEntries: 20,
        tenantQuotas: {
          'tenant-1': { maxTotalBytes: 2000, maxEntries: 8 },
          'tenant-2': { maxTotalBytes: 2000, maxEntries: 8 },
        },
      });

      const tenants = ['tenant-1', 'tenant-2', 'default'];
      const activeKeys: Map<string, { namespace: string; size: number }> = new Map();

      for (let op = 0; op < 50; op++) {
        const action = nextRandom();
        const tenant = tenants[Math.floor(nextRandom() * tenants.length)];
        const pathNum = Math.floor(nextRandom() * 12);
        const urlPath = `/item-${pathNum}`;
        const bodyLength = 50 + Math.floor(nextRandom() * 200);

        if (action < 0.6) {
          // Set operation
          const entry = makeEntry({
            urlPath,
            namespace: tenant,
            bodyText: 'X'.repeat(bodyLength),
            now: 1000 + op * 10,
          });
          const success = currentStore.set(entry);
          if (success) {
            activeKeys.set(entry.keyHash, { namespace: tenant, size: entry.size });
          }
        } else if (action < 0.85) {
          // Read operation
          const keys = Array.from(activeKeys.keys());
          if (keys.length > 0) {
            const keyToRead = keys[Math.floor(nextRandom() * keys.length)];
            const entry = currentStore.get(keyToRead);
            if (!entry) {
              activeKeys.delete(keyToRead); // Must have been evicted
            }
          }
        } else {
          // Delete operation
          const keys = Array.from(activeKeys.keys());
          if (keys.length > 0) {
            const keyToDelete = keys[Math.floor(nextRandom() * keys.length)];
            currentStore.delete(keyToDelete);
            activeKeys.delete(keyToDelete);
          }
        }

        // Restart store periodically (e.g. every 15 operations)
        if (op % 15 === 14) {
          currentStore = new DiskStore({
            dirPath: tempDir,
            maxTotalBytes: 5000,
            maxEntries: 20,
            tenantQuotas: {
              'tenant-1': { maxTotalBytes: 2000, maxEntries: 8 },
              'tenant-2': { maxTotalBytes: 2000, maxEntries: 8 },
            },
          });
        }
      }

      // Final Consistency Check
      const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.cache'));
      const metaIndex = currentStore.getMetadataIndex();

      // 1. Disk files count equals metadata index size
      expect(files.length).toBe(metaIndex.size);

      // 2. Each file corresponds exactly to an entry in metadataIndex
      let diskTotalPayloadBytes = 0;
      for (const file of files) {
        const hexStr = file.replace(/\.cache$/, '');
        const keyHash = Buffer.from(hexStr, 'hex').toString('utf8');
        const meta = metaIndex.get(keyHash);
        expect(meta).toBeDefined();
        diskTotalPayloadBytes += meta!.size;
      }

      // 3. Store's recorded bytes equal sum of metadata sizes
      const stats = currentStore.stats();
      expect(stats.entries).toBe(metaIndex.size);
      expect(stats.totalBytes).toBe(diskTotalPayloadBytes);

      // 4. Sum of all tenant stats equals totalBytes and entries
      let totalTenantBytes = 0;
      let totalTenantEntries = 0;
      for (const t of tenants) {
        const tStats = currentStore.getTenantStats(t);
        totalTenantBytes += tStats.totalBytes;
        totalTenantEntries += tStats.entries;
      }
      expect(totalTenantBytes).toBe(diskTotalPayloadBytes);
      expect(totalTenantEntries).toBe(metaIndex.size);
    });
  });
});
