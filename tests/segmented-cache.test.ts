import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SlruPolicy } from '../src/cache/eviction/slru.js';
import { LruPolicy } from '../src/cache/eviction/lru.js';
import { LfuPolicy } from '../src/cache/eviction/lfu.js';
import { EvictionPolicy } from '../src/cache/eviction/policy.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { DiskStore } from '../src/cache/disk-store.js';
import { CacheEntry } from '../src/cache/store.js';

function createDummyEntry(keyHash: string, size: number = 20): CacheEntry {
  const body = Buffer.alloc(size, 'x');
  return {
    keyHash,
    keyString: `GET https://example.com/${keyHash}`,
    originId: 'origin-1',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=300' },
    body,
    size,
    storedAt: 1000,
    hitCount: 0,
    lastAccessedAt: 1000,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 300000,
    lifetimeSource: 'max-age',
  };
}

describe('Feature 36: Segmented cache (SLRU)', () => {
  describe('SLRU policy logic', () => {
    it('initial insert places entry in probation; second hit promotes it to protected segment', () => {
      const policy = new SlruPolicy({ protectedRatio: 0.8, maxEntries: 10 });

      policy.onInsert('key-1');
      expect(policy.isInProbation('key-1')).toBe(true);
      expect(policy.isInProtected('key-1')).toBe(false);

      // First hit / access: promotes to protected
      policy.onAccess('key-1');
      expect(policy.isInProbation('key-1')).toBe(false);
      expect(policy.isInProtected('key-1')).toBe(true);
    });

    it('scan resistance: a flood of one-hit entries cannot flush frequently used protected entries', () => {
      // 5 entries max: 3 protected (0.6 ratio), 2 probation
      const policy = new SlruPolicy({ protectedRatio: 0.6, maxEntries: 5 });

      // Prime 3 entries into protected segment (insert + access)
      ['hot-1', 'hot-2', 'hot-3'].forEach((k) => {
        policy.onInsert(k);
        policy.onAccess(k); // promote to protected
        expect(policy.isInProtected(k)).toBe(true);
      });

      // Flood with 20 one-hit scan entries
      for (let i = 0; i < 20; i++) {
        const scanKey = `scan-${i}`;
        policy.onInsert(scanKey);

        // When size exceeds budget, evict victim
        if (policy.size() > 5) {
          const victim = policy.pickVictim();
          expect(victim).toBeDefined();
          // The victim MUST be from the probation segment (a scan key), NEVER a hot key
          expect(victim?.startsWith('scan-')).toBe(true);
          expect(['hot-1', 'hot-2', 'hot-3'].includes(victim!)).toBe(false);
          policy.onRemove(victim!);
        }
      }

      // Hot entries are completely preserved in the protected segment
      expect(policy.isInProtected('hot-1')).toBe(true);
      expect(policy.isInProtected('hot-2')).toBe(true);
      expect(policy.isInProtected('hot-3')).toBe(true);
    });

    it('eviction order is deterministic: oldest probation evicted first, then protected if probation empty', () => {
      const policy = new SlruPolicy({ protectedRatio: 0.5, maxEntries: 4 });

      // Add p1, p2 to probation
      policy.onInsert('p1');
      policy.onInsert('p2');

      // Add h1, h2 to protected
      policy.onInsert('h1');
      policy.onAccess('h1');
      policy.onInsert('h2');
      policy.onAccess('h2');

      // Eviction order must be p1, then p2, then h1, then h2
      expect(policy.pickVictim()).toBe('p1');
      policy.onRemove('p1');

      expect(policy.pickVictim()).toBe('p2');
      policy.onRemove('p2');

      expect(policy.pickVictim()).toBe('h1');
      policy.onRemove('h1');

      expect(policy.pickVictim()).toBe('h2');
      policy.onRemove('h2');

      expect(policy.pickVictim()).toBeUndefined();
    });

    it('segment ratio is configurable (e.g. 0.8 vs 0.5 vs 0.2)', () => {
      const slru80 = new SlruPolicy({ protectedRatio: 0.8, maxEntries: 10 });
      expect(slru80.protectedCapacity).toBe(8);
      expect(slru80.probationCapacity).toBe(2);

      const slru50 = new SlruPolicy({ protectedRatio: 0.5, maxEntries: 10 });
      expect(slru50.protectedCapacity).toBe(5);
      expect(slru50.probationCapacity).toBe(5);

      const slru20 = new SlruPolicy({ protectedRatio: 0.2, maxEntries: 10 });
      expect(slru20.protectedCapacity).toBe(2);
      expect(slru20.probationCapacity).toBe(8);
    });

    it('demotes protected LRU entry to probation when protected segment is full', () => {
      // 2 protected entries max
      const policy = new SlruPolicy({ protectedRatio: 0.5, maxEntries: 4 });

      policy.onInsert('h1');
      policy.onAccess('h1'); // in protected
      policy.onInsert('h2');
      policy.onAccess('h2'); // in protected

      expect(policy.isInProtected('h1')).toBe(true);
      expect(policy.isInProtected('h2')).toBe(true);

      // Now promote h3 into protected -> exceeds protected capacity (2), so h1 (oldest) is demoted to probation
      policy.onInsert('h3');
      policy.onAccess('h3');

      expect(policy.isInProtected('h3')).toBe(true);
      expect(policy.isInProtected('h2')).toBe(true);
      expect(policy.isInProbation('h1')).toBe(true);
    });
  });

  describe('Policy switching: LRU, LFU, and SLRU run through the same interface', () => {
    function testPolicyContract(policy: EvictionPolicy) {
      expect(policy.name).toBeDefined();
      expect(policy.size()).toBe(0);

      policy.onInsert('k1');
      policy.onInsert('k2');
      expect(policy.size()).toBe(2);

      policy.onAccess('k1');
      const victim = policy.pickVictim();
      expect(['k1', 'k2'].includes(victim!)).toBe(true);

      policy.onRemove(victim!);
      expect(policy.size()).toBe(1);

      policy.clear();
      expect(policy.size()).toBe(0);
      expect(policy.pickVictim()).toBeUndefined();
    }

    it('passes standard contract across LRU, LFU, and SLRU', () => {
      testPolicyContract(new LruPolicy());
      testPolicyContract(new LfuPolicy());
      testPolicyContract(new SlruPolicy({ protectedRatio: 0.7 }));
    });
  });

  describe('Integration with MemoryStore and DiskStore under size eviction', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), `cdn-cache-slru-test-${randomUUID()}`);
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it('MemoryStore with SLRU protects frequently accessed items during scan', () => {
      const store = new MemoryStore({
        maxTotalBytes: 100,
        maxEntries: 5,
        evictionPolicy: new SlruPolicy({ protectedRatio: 0.6, maxEntries: 5 }),
      });

      // Hot entries: 20 bytes each
      const hot1 = createDummyEntry('hot-1', 20);
      const hot2 = createDummyEntry('hot-2', 20);
      store.set(hot1);
      store.recordHit('hot-1'); // promoted to protected
      store.set(hot2);
      store.recordHit('hot-2'); // promoted to protected

      // Flood with 10 one-hit scan entries of 20 bytes each
      for (let i = 0; i < 10; i++) {
        store.set(createDummyEntry(`scan-${i}`, 20));
      }

      // Hot entries are preserved
      expect(store.get('hot-1')).toBeDefined();
      expect(store.get('hot-2')).toBeDefined();
      expect(store.stats().entries).toBeLessThanOrEqual(5);
      expect(store.stats().totalBytes).toBeLessThanOrEqual(100);
    });

    it('DiskStore with SLRU protects frequently accessed items on disk', () => {
      const store = new DiskStore({
        dirPath: tempDir,
        maxTotalBytes: 100,
        maxEntries: 5,
        evictionPolicy: new SlruPolicy({ protectedRatio: 0.6, maxEntries: 5 }),
      });

      const hot1 = createDummyEntry('hot-disk-1', 25);
      const hot2 = createDummyEntry('hot-disk-2', 25);
      store.set(hot1);
      store.recordHit('hot-disk-1');
      store.set(hot2);
      store.recordHit('hot-disk-2');

      for (let i = 0; i < 8; i++) {
        store.set(createDummyEntry(`scan-disk-${i}`, 25));
      }

      expect(store.get('hot-disk-1')).toBeDefined();
      expect(store.get('hot-disk-2')).toBeDefined();
      expect(fs.existsSync(store.getFilePath('hot-disk-1'))).toBe(true);
      expect(fs.existsSync(store.getFilePath('hot-disk-2'))).toBe(true);
      expect(store.stats().totalBytes).toBeLessThanOrEqual(100);
    });
  });
});
