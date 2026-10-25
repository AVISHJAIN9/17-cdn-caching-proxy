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
  const body = overrides.body ?? Buffer.from('persistent payload body');
  return {
    keyHash: 'hash-persist-1',
    keyString: 'GET https://example.com/item',
    originId: 'origin-persist',
    status: 200,
    statusMessage: 'OK',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=600',
      etag: '"persist-etag-1"',
      'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
    },
    body,
    size: body.byteLength,
    storedAt: 5000,
    hitCount: 3,
    lastAccessedAt: 5500,
    requestTimeMs: 4950,
    responseTimeMs: 5000,
    dateValueMs: 5000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 600000,
    lifetimeSource: 'max-age',
    etag: { raw: '"persist-etag-1"', opaque: 'persist-etag-1', weak: false },
    etagRaw: '"persist-etag-1"',
    lastModifiedMs: 1792567680000,
    lastModifiedRaw: 'Wed, 21 Oct 2026 07:28:00 GMT',
    ...overrides,
  };
}

describe('Feature 29: Persistent cache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `cdn-cache-persist-test-${randomUUID()}`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('startup with an empty or non-existent directory works cleanly', () => {
    expect(fs.existsSync(tempDir)).toBe(false);

    const store = new DiskStore({ dirPath: tempDir });
    expect(fs.existsSync(tempDir)).toBe(true);
    expect(store.stats().entries).toBe(0);
    expect(store.stats().totalBytes).toBe(0);
  });

  it('cache survives restart: rebuilds metadata index from disk and serves entries with freshness data', () => {
    // 1. Initial instance: store entries
    const store1 = new DiskStore({ dirPath: tempDir });
    const entry1 = createDummyEntry({ keyHash: 'p1', body: Buffer.from('body-one') });
    const entry2 = createDummyEntry({
      keyHash: 'p2',
      body: Buffer.from('body-two-longer'),
      headers: {
        'content-type': 'text/plain',
        'cache-control': 's-maxage=1200',
        etag: '"tag-2"',
      },
      freshnessLifetimeMs: 1200000,
      lifetimeSource: 's-maxage',
    });

    store1.set(entry1);
    store1.set(entry2);
    expect(store1.stats().entries).toBe(2);
    const expectedBytes = entry1.size + entry2.size;
    expect(store1.stats().totalBytes).toBe(expectedBytes);

    // 2. Simulate process restart by constructing a new DiskStore instance pointing to the same directory
    const store2 = new DiskStore({ dirPath: tempDir });

    // Index must be rebuilt
    expect(store2.stats().entries).toBe(2);
    expect(store2.stats().totalBytes).toBe(expectedBytes);
    expect(store2.sumLiveBytes()).toBe(expectedBytes);

    // Verify entry 1
    const got1 = store2.get('p1');
    expect(got1).toBeDefined();
    expect(got1?.body.toString('utf8')).toBe('body-one');
    expect(got1?.storedAt).toBe(5000);
    expect(got1?.etagRaw).toBe('"persist-etag-1"');
    expect(got1?.headers['cache-control']).toBe('public, max-age=600');
    expect(got1?.freshnessLifetimeMs).toBe(600000);

    // Verify entry 2
    const got2 = store2.get('p2');
    expect(got2).toBeDefined();
    expect(got2?.body.toString('utf8')).toBe('body-two-longer');
    expect(got2?.headers['cache-control']).toBe('s-maxage=1200');
    expect(got2?.freshnessLifetimeMs).toBe(1200000);
  });

  it('truncated and corrupt files are dropped and deleted at startup', () => {
    // 1. Set up store with one valid entry
    const store1 = new DiskStore({ dirPath: tempDir });
    const validEntry = createDummyEntry({ keyHash: 'valid-file', body: Buffer.from('valid data') });
    store1.set(validEntry);

    // 2. Manually inject corrupt and truncated files into the cache directory
    const corruptFile = path.join(tempDir, `${Buffer.from('corrupt-key').toString('hex')}.cache`);
    fs.writeFileSync(corruptFile, Buffer.from('NOT_A_VALID_HEADER_DATA'));

    const truncatedFile = path.join(tempDir, `${Buffer.from('trunc-key').toString('hex')}.cache`);
    fs.writeFileSync(truncatedFile, Buffer.alloc(20)); // shorter than 48-byte header

    // 3. Restart: New store must drop and unlink corrupt and truncated files
    const store2 = new DiskStore({ dirPath: tempDir });
    expect(store2.stats().entries).toBe(1);
    expect(store2.get('valid-file')).toBeDefined();
    expect(store2.get('corrupt-key')).toBeUndefined();
    expect(store2.get('trunc-key')).toBeUndefined();

    // Corrupt files must be deleted from disk
    expect(fs.existsSync(corruptFile)).toBe(false);
    expect(fs.existsSync(truncatedFile)).toBe(false);
  });

  it('orphan temp files are cleaned up at startup', () => {
    fs.mkdirSync(tempDir, { recursive: true });

    // Create orphan temp files left over from simulated crashes
    const orphan1 = path.join(tempDir, '.orphan1.123456.tmp');
    const orphan2 = path.join(tempDir, 'temp-file.tmp');
    fs.writeFileSync(orphan1, Buffer.from('temp data 1'));
    fs.writeFileSync(orphan2, Buffer.from('temp data 2'));
    expect(fs.existsSync(orphan1)).toBe(true);
    expect(fs.existsSync(orphan2)).toBe(true);

    // Startup DiskStore
    const store = new DiskStore({ dirPath: tempDir });
    expect(fs.existsSync(orphan1)).toBe(false);
    expect(fs.existsSync(orphan2)).toBe(false);
    expect(store.stats().entries).toBe(0);
  });

  it('byte counts after restart equal the sum of the live files', () => {
    const store1 = new DiskStore({ dirPath: tempDir });
    const sizes = [15, 250, 1024, 4096];
    let totalExpected = 0;

    sizes.forEach((s, i) => {
      const entry = createDummyEntry({
        keyHash: `size-k${i}`,
        body: Buffer.alloc(s, `x${i}`),
      });
      store1.set(entry);
      totalExpected += s;
    });

    expect(store1.stats().totalBytes).toBe(totalExpected);

    // Restart
    const store2 = new DiskStore({ dirPath: tempDir });
    expect(store2.stats().totalBytes).toBe(totalExpected);
    expect(store2.sumLiveBytes()).toBe(totalExpected);
  });

  it('proxy integration: cached representations survive proxy restart without origin refetch', async () => {
    let originRequests = 0;
    const testClock = new FakeClock(1000);

    const originServer = http.createServer((req, res) => {
      originRequests++;
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'max-age=3600',
        ETag: '"survive-restart"',
      });
      res.end('origin-content-v1');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    const originPort = (originServer.address() as AddressInfo).port;

    // 1. Run proxy with DiskStore and prime the cache
    const storeInstance1 = new DiskStore({ dirPath: tempDir });
    let proxy1: ProxyListener | undefined = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store: storeInstance1,
      clock: testClock,
      cache: { enabled: true, key: { includeHost: false } },
    });

    const port1 = proxy1.httpPort!;
    const res1 = await fetch(`http://127.0.0.1:${port1}/persistent-resource`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(await res1.text()).toBe('origin-content-v1');
    expect(originRequests).toBe(1);

    // Stop proxy 1
    await proxy1.stop();
    proxy1 = undefined;

    // 2. Start new proxy instance pointing to the same disk cache directory
    const storeInstance2 = new DiskStore({ dirPath: tempDir });
    let proxy2: ProxyListener | undefined;
    try {
      proxy2 = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        store: storeInstance2,
        clock: testClock,
        cache: { enabled: true, key: { includeHost: false } },
      });

      const port2 = proxy2.httpPort!;
      const res2 = await fetch(`http://127.0.0.1:${port2}/persistent-resource`);
      expect(res2.status).toBe(200);
      expect(res2.headers.get('x-cache')).toBe('HIT');
      expect(await res2.text()).toBe('origin-content-v1');
      // Origin was NOT called because cached entry was restored from disk
      expect(originRequests).toBe(1);
    } finally {
      if (proxy2) await proxy2.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });
});
