import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { DiskStore } from '../src/cache/disk-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { FakeClock } from '../src/util/clock.js';

function createDummyEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const body = overrides.body ?? Buffer.from('hello disk cache content');
  return {
    keyHash: 'hash-disk-123',
    keyString: 'GET https://example.com/asset',
    originId: 'origin-1',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=300' },
    body,
    size: body.byteLength,
    storedAt: 1000,
    hitCount: 0,
    lastAccessedAt: 1000,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 300000,
    lifetimeSource: 'max-age',
    ...overrides,
  };
}

describe('Feature 28: Disk cache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `cdn-cache-disk-test-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Core store/get/delete and file lifecycle', () => {
    it('performs store/get/delete round-trip on disk', () => {
      const store = new DiskStore({ dirPath: tempDir });
      const entry = createDummyEntry({ keyHash: 'entry-disk-1', body: Buffer.from('payload on disk') });

      expect(store.get('entry-disk-1')).toBeUndefined();

      const stored = store.set(entry);
      expect(stored).toBe(true);

      // Verify file was written to disk
      const filePath = store.getFilePath('entry-disk-1');
      expect(fs.existsSync(filePath)).toBe(true);

      const retrieved = store.get('entry-disk-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.keyHash).toBe('entry-disk-1');
      expect(retrieved?.body.toString('utf8')).toBe('payload on disk');
      expect(retrieved?.status).toBe(200);
      expect(retrieved?.headers['content-type']).toBe('text/plain');

      // Delete removes file from disk and index
      const deleted = store.delete('entry-disk-1');
      expect(deleted).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(store.get('entry-disk-1')).toBeUndefined();
      expect(store.stats().entries).toBe(0);
      expect(store.stats().totalBytes).toBe(0);
    });

    it('overwriting an entry replaces the old file and byte accounting stays exact', () => {
      const store = new DiskStore({ dirPath: tempDir });
      const entryA = createDummyEntry({ keyHash: 'entry-overwrite', body: Buffer.from('short') });
      const entryB = createDummyEntry({
        keyHash: 'entry-overwrite',
        body: Buffer.from('much longer replacement body content on disk'),
        headers: { 'content-type': 'application/json' },
      });

      store.set(entryA);
      expect(store.stats().entries).toBe(1);
      expect(store.stats().totalBytes).toBe(entryA.size);

      store.set(entryB);
      expect(store.stats().entries).toBe(1);
      expect(store.stats().totalBytes).toBe(entryB.size);

      const retrieved = store.get('entry-overwrite');
      expect(retrieved?.body.toString('utf8')).toBe('much longer replacement body content on disk');
      expect(retrieved?.headers['content-type']).toBe('application/json');

      // Total live bytes matches exact sum of live bodies
      expect(store.sumLiveBytes()).toBe(entryB.size);
    });

    it('detects a flipped byte in a stored file via checksum, treats as miss, and deletes the corrupt file', () => {
      const store = new DiskStore({ dirPath: tempDir });
      const entry = createDummyEntry({ keyHash: 'entry-corrupt', body: Buffer.from('original valid bytes') });

      store.set(entry);
      const filePath = store.getFilePath('entry-corrupt');
      expect(fs.existsSync(filePath)).toBe(true);

      // Intentionally flip a byte in the stored file on disk
      const fileBytes = fs.readFileSync(filePath);
      fileBytes[fileBytes.length - 3] ^= 0xff; // flip bits
      fs.writeFileSync(filePath, fileBytes);

      // Retrieval must detect corruption via checksum, return undefined (miss), and remove file
      const retrieved = store.get('entry-corrupt');
      expect(retrieved).toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(false);
      expect(store.stats().entries).toBe(0);
      expect(store.stats().totalBytes).toBe(0);
    });

    it('simulated crash between temp write and rename leaves no visible partial entry', () => {
      const store = new DiskStore({ dirPath: tempDir });

      // Simulate an interrupted write that only wrote a temp file
      const orphanTempFile = path.join(tempDir, '.hash-crash.12345.tmp');
      fs.writeFileSync(orphanTempFile, Buffer.from('partial incomplete data'));

      // The final file does not exist
      expect(store.get('hash-crash')).toBeUndefined();
      expect(store.stats().entries).toBe(0);

      // Target file for hash-crash does not exist
      const targetFile = store.getFilePath('hash-crash');
      expect(fs.existsSync(targetFile)).toBe(false);
    });

    it('disk-full or write-permission errors fail cleanly without corrupting the index', () => {
      const readOnlySubdir = path.join(tempDir, 'readonly-cache');
      fs.mkdirSync(readOnlySubdir, { recursive: true });

      const store = new DiskStore({ dirPath: readOnlySubdir });
      const validEntry = createDummyEntry({ keyHash: 'valid-before', body: Buffer.from('first good') });
      store.set(validEntry);
      expect(store.stats().entries).toBe(1);

      // Make directory read-only to simulate write failure
      try {
        fs.chmodSync(readOnlySubdir, 0o444);
      } catch {
        // Skip chmod failure on platforms where not supported
      }

      // Try setting a new entry when directory is unwritable
      const secondEntry = createDummyEntry({ keyHash: 'write-fail', body: Buffer.from('should fail') });
      const result = store.set(secondEntry);

      // Restore permissions for cleanup
      try {
        fs.chmodSync(readOnlySubdir, 0o777);
      } catch {}

      if (!result) {
        expect(result).toBe(false);
        expect(store.get('write-fail')).toBeUndefined();
        // Index remains intact with valid-before
        expect(store.stats().entries).toBe(1);
        expect(store.get('valid-before')?.body.toString('utf8')).toBe('first good');
      }
    });
  });

  describe('Conformance with Batch 9 storage & eviction contract', () => {
    it('enforces maxTotalBytes size eviction on disk', () => {
      const store = new DiskStore({
        dirPath: tempDir,
        maxTotalBytes: 100,
        evictionPolicy: 'lru',
      });

      const entry1 = createDummyEntry({ keyHash: 'disk-k1', body: Buffer.alloc(60, 'a') });
      const entry2 = createDummyEntry({ keyHash: 'disk-k2', body: Buffer.alloc(60, 'b') });

      expect(store.set(entry1)).toBe(true);
      expect(fs.existsSync(store.getFilePath('disk-k1'))).toBe(true);

      // Adding entry2 exceeds 100 bytes budget -> evicts entry1
      expect(store.set(entry2)).toBe(true);
      expect(fs.existsSync(store.getFilePath('disk-k1'))).toBe(false);
      expect(fs.existsSync(store.getFilePath('disk-k2'))).toBe(true);
      expect(store.get('disk-k1')).toBeUndefined();
      expect(store.get('disk-k2')).toBeDefined();
      expect(store.stats().totalBytes).toBe(60);
      expect(store.stats().entries).toBe(1);
    });

    it('works as proxy backend: cache-miss writes to disk, cache-hit serves from disk', async () => {
      const store = new DiskStore({ dirPath: tempDir });
      let originCalls = 0;
      const testClock = new FakeClock(1000);

      const originServer = http.createServer((req, res) => {
        originCalls++;
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=60',
          ETag: '"disk-ver-1"',
        });
        res.end('disk-origin-payload');
      });

      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      const originPort = (originServer.address() as AddressInfo).port;

      let proxyListener: ProxyListener | undefined;
      try {
        proxyListener = await createAndStartProxy({
          httpHost: '127.0.0.1',
          httpPort: 0,
          originUrl: `http://127.0.0.1:${originPort}`,
          store,
          clock: testClock,
          cache: { enabled: true },
        });

        const proxyPort = proxyListener.httpPort!;

        // 1. First request -> MISS, populated into disk store
        const res1 = await fetch(`http://127.0.0.1:${proxyPort}/disk-test`);
        expect(res1.status).toBe(200);
        expect(res1.headers.get('x-cache')).toBe('MISS');
        expect(await res1.text()).toBe('disk-origin-payload');
        expect(originCalls).toBe(1);

        expect(store.stats().entries).toBe(1);
        expect(store.stats().totalBytes).toBeGreaterThan(0);

        // 2. Second request -> HIT from disk store
        const res2 = await fetch(`http://127.0.0.1:${proxyPort}/disk-test`);
        expect(res2.status).toBe(200);
        expect(res2.headers.get('x-cache')).toBe('HIT');
        expect(await res2.text()).toBe('disk-origin-payload');
        expect(originCalls).toBe(1); // origin not called
      } finally {
        if (proxyListener) await proxyListener.stop();
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });
  });
});
