import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../src/cache/memory-store.js';
import { DiskStore } from '../src/cache/disk-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { generateCacheKey } from '../src/cache/key.js';
import { CacheTeeStream } from '../src/cache/fill.js';

function makeEntry(opts: {
  urlPath: string;
  bodyText: string;
  namespace?: string;
  now?: number;
}): CacheEntry {
  const now = opts.now ?? Date.now();
  const ns = opts.namespace ?? 'default';
  const { keyString, keyHash } = generateCacheKey({
    host: 'example.com',
    normalizedPath: opts.urlPath,
    normalizedQuery: '',
    method: 'GET',
    originId: 'origin-1',
    namespace: ns,
  });
  const body = Buffer.from(opts.bodyText, 'utf-8');

  return {
    keyHash,
    keyString,
    originId: 'origin-1',
    namespace: ns,
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

describe('Feature 39: Object limits', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-limits-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('maxObjectBytes clean rejection in MemoryStore and DiskStore', () => {
    it('MemoryStore rejects oversized object cleanly with documented behavior; does not evict existing entries', () => {
      const store = new MemoryStore({
        maxObjectBytes: 150,
        maxTotalBytes: 1000,
      });

      const validEntry = makeEntry({ urlPath: '/valid', bodyText: 'A'.repeat(100) });
      expect(store.set(validEntry)).toBe(true);

      // Attempt to store oversized object (200 B > 150 B)
      const oversized = makeEntry({ urlPath: '/oversized', bodyText: 'B'.repeat(200) });
      const result = store.set(oversized);

      // Defined rejection result: false
      expect(result).toBe(false);

      // Existing entry is NOT evicted
      expect(store.get(validEntry.keyHash)).toBeDefined();
      expect(store.get(oversized.keyHash)).toBeUndefined();

      // Stats reflect accurate accounting
      const stats = store.stats();
      expect(stats.entries).toBe(1);
      expect(stats.totalBytes).toBe(100);
      expect(stats.storeSkipped).toBe(1);
    });

    it('DiskStore rejects oversized object without writing temp file or leaving partial state; does not evict existing entries', () => {
      const store = new DiskStore({
        dirPath: tempDir,
        maxObjectBytes: 200,
        maxTotalBytes: 5000,
      });

      const validEntry = makeEntry({ urlPath: '/valid-disk', bodyText: 'D'.repeat(150) });
      expect(store.set(validEntry)).toBe(true);
      expect(fs.existsSync(store.getFilePath(validEntry.keyHash))).toBe(true);

      // Attempt to store oversized entry (300 B > 200 B)
      const oversized = makeEntry({ urlPath: '/too-large-disk', bodyText: 'X'.repeat(300) });
      const result = store.set(oversized);

      expect(result).toBe(false);
      expect(store.get(oversized.keyHash)).toBeUndefined();

      // No partial file or temp file left on disk
      const files = fs.readdirSync(tempDir);
      expect(files.length).toBe(1);
      expect(files[0].endsWith('.cache')).toBe(true);
      expect(files.filter(f => f.includes('tmp')).length).toBe(0);

      // Existing valid entry untouched
      expect(store.get(validEntry.keyHash)).toBeDefined();
      const stats = store.stats();
      expect(stats.entries).toBe(1);
      expect(stats.totalBytes).toBe(150);
      expect(stats.storeSkipped).toBe(1);
    });
  });

  describe('maxEntries enforcement', () => {
    it('enforces entry limit with evictionPolicy none: rejects new entries cleanly when limit reached', () => {
      const store = new MemoryStore({
        maxEntries: 2,
        evictionPolicy: 'none',
      });

      const e1 = makeEntry({ urlPath: '/e1', bodyText: 'one' });
      const e2 = makeEntry({ urlPath: '/e2', bodyText: 'two' });
      const e3 = makeEntry({ urlPath: '/e3', bodyText: 'three' });

      expect(store.set(e1)).toBe(true);
      expect(store.set(e2)).toBe(true);

      // Store is full on entries (2/2) and no eviction policy is active
      expect(store.set(e3)).toBe(false);
      expect(store.get(e1.keyHash)).toBeDefined();
      expect(store.get(e2.keyHash)).toBeDefined();
      expect(store.get(e3.keyHash)).toBeUndefined();
      expect(store.stats().entries).toBe(2);
      expect(store.stats().storeSkipped).toBe(1);
    });

    it('enforces entry limit with LRU eviction: maintains maxEntries bounds across insertions', () => {
      const store = new DiskStore({
        dirPath: tempDir,
        maxEntries: 3,
        evictionPolicy: 'lru',
      });

      const e1 = makeEntry({ urlPath: '/e1', bodyText: '1', now: 1000 });
      const e2 = makeEntry({ urlPath: '/e2', bodyText: '2', now: 2000 });
      const e3 = makeEntry({ urlPath: '/e3', bodyText: '3', now: 3000 });
      const e4 = makeEntry({ urlPath: '/e4', bodyText: '4', now: 4000 });

      expect(store.set(e1)).toBe(true);
      expect(store.set(e2)).toBe(true);
      expect(store.set(e3)).toBe(true);
      expect(store.stats().entries).toBe(3);

      // 4th entry evicts e1 (oldest LRU)
      expect(store.set(e4)).toBe(true);
      expect(store.stats().entries).toBe(3);
      expect(store.get(e1.keyHash)).toBeUndefined();
      expect(store.get(e2.keyHash)).toBeDefined();
      expect(store.get(e3.keyHash)).toBeDefined();
      expect(store.get(e4.keyHash)).toBeDefined();

      // Files on disk match entries count exactly
      const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.cache'));
      expect(files.length).toBe(3);
    });
  });

  describe('Streaming CacheTeeStream: clean rejection for oversized streams', () => {
    it('Content-Length exceeding maxObjectBytes skips caching immediately and streams body cleanly', async () => {
      const store = new MemoryStore({ maxObjectBytes: 100 });
      let skippedReason: string | undefined;

      const tee = new CacheTeeStream({
        store,
        statusCode: 200,
        originHeaders: {
          'content-type': 'text/plain',
          'content-length': '250',
          'cache-control': 'public, max-age=3600',
        },
        rawHeaders: [],
        keyHash: 'dummy-hash',
        keyString: 'dummy-key',
        originId: 'origin-1',
        requestTimeMs: Date.now(),
        responseTimeMs: Date.now() + 5,
        config: {} as any,
        clock: { now: () => Date.now() },
        onSkipped: (reason) => {
          skippedReason = reason;
        },
      });

      expect(skippedReason).toBe('too_large');

      // Verify that streaming data to client is completely unaffected
      const chunks: Buffer[] = [];
      tee.on('data', (c) => chunks.push(c));

      const input = Buffer.from('Y'.repeat(250), 'utf-8');
      tee.write(input);
      tee.end();

      await new Promise<void>((resolve) => tee.on('end', () => resolve()));
      expect(Buffer.concat(chunks).toString('utf-8')).toBe('Y'.repeat(250));

      // No entry was stored in cache
      expect(store.get('dummy-hash')).toBeUndefined();
      expect(store.stats().entries).toBe(0);
    });

    it('chunked body exceeding maxObjectBytes mid-stream drops buffer and passes stream untouched to client', async () => {
      const store = new MemoryStore({ maxObjectBytes: 150 });
      let skippedReason: string | undefined;

      const tee = new CacheTeeStream({
        store,
        statusCode: 200,
        originHeaders: {
          'content-type': 'text/plain',
          'cache-control': 'public, max-age=3600',
        },
        rawHeaders: [],
        keyHash: 'chunked-hash',
        keyString: 'chunked-key',
        originId: 'origin-1',
        requestTimeMs: Date.now(),
        responseTimeMs: Date.now() + 5,
        config: {} as any,
        clock: { now: () => Date.now() },
        onSkipped: (reason) => {
          skippedReason = reason;
        },
      });

      const clientChunks: Buffer[] = [];
      tee.on('data', (c) => clientChunks.push(c));

      // 1st chunk: 100 bytes (within 150 byte limit)
      tee.write(Buffer.from('Z'.repeat(100)));
      expect(skippedReason).toBeUndefined();

      // 2nd chunk: 100 bytes (total 200 bytes > 150 bytes limit)
      tee.write(Buffer.from('Z'.repeat(100)));
      expect(skippedReason).toBe('too_large');

      tee.end();
      await new Promise<void>((resolve) => tee.on('end', () => resolve()));

      // Client received all 200 bytes intact
      expect(Buffer.concat(clientChunks).length).toBe(200);

      // Store remains empty with zero partial state
      expect(store.get('chunked-hash')).toBeUndefined();
      expect(store.stats().entries).toBe(0);
    });
  });
});
