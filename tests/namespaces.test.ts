import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { generateCacheKey } from '../src/cache/key.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { DiskStore } from '../src/cache/disk-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { FakeClock } from '../src/util/clock.js';

function createDummyEntry(namespace: string, path: string, bodyText: string): CacheEntry {
  const key = generateCacheKey({
    namespace,
    originId: 'default',
    method: 'GET',
    host: 'cdn.example.com',
    normalizedPath: path,
    normalizedQuery: '',
    includeHost: true,
  });
  const body = Buffer.from(bodyText);

  return {
    keyHash: key.keyHash,
    keyString: key.keyString,
    originId: 'default',
    namespace,
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=600' },
    body,
    size: body.byteLength,
    storedAt: 1000,
    hitCount: 0,
    lastAccessedAt: 1000,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 600000,
    lifetimeSource: 'max-age',
  };
}

describe('Feature 37: Namespaces', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `cdn-cache-ns-test-${randomUUID()}`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Namespace collision resistance', () => {
    it('special characters in namespace cannot collide (collision test: "a:b" + "c" vs "a" + "b:c")', () => {
      const key1 = generateCacheKey({
        namespace: 'a:b',
        originId: 'default',
        method: 'GET',
        host: 'example.com',
        normalizedPath: '/c',
        normalizedQuery: '',
        includeHost: true,
      });

      const key2 = generateCacheKey({
        namespace: 'a',
        originId: 'default',
        method: 'GET',
        host: 'example.com',
        normalizedPath: '/b:c',
        normalizedQuery: '',
        includeHost: true,
      });

      expect(key1.keyString).not.toBe(key2.keyString);
      expect(key1.keyHash).not.toBe(key2.keyHash);
    });

    it('same URL path across two namespaces produces two completely distinct cache keys and hashes', () => {
      const keyTenantA = generateCacheKey({
        namespace: 'tenant-alpha',
        originId: 'default',
        method: 'GET',
        host: 'example.com',
        normalizedPath: '/profile',
        normalizedQuery: '',
        includeHost: true,
      });

      const keyTenantB = generateCacheKey({
        namespace: 'tenant-beta',
        originId: 'default',
        method: 'GET',
        host: 'example.com',
        normalizedPath: '/profile',
        normalizedQuery: '',
        includeHost: true,
      });

      expect(keyTenantA.keyHash).not.toBe(keyTenantB.keyHash);
      expect(keyTenantA.keyString).not.toBe(keyTenantB.keyString);
    });
  });

  describe('Storage isolation and lifecycle', () => {
    it('same URL in two namespaces gives independent entries in MemoryStore and DiskStore', () => {
      const memStore = new MemoryStore();
      const entryA = createDummyEntry('tenant-A', '/settings', 'settings-for-A');
      const entryB = createDummyEntry('tenant-B', '/settings', 'settings-for-B');

      memStore.set(entryA);
      memStore.set(entryB);

      expect(memStore.stats().entries).toBe(2);

      // Verify independent retrieval
      const gotA = memStore.get(entryA.keyHash);
      const gotB = memStore.get(entryB.keyHash);
      expect(gotA?.body.toString('utf8')).toBe('settings-for-A');
      expect(gotA?.namespace).toBe('tenant-A');
      expect(gotB?.body.toString('utf8')).toBe('settings-for-B');
      expect(gotB?.namespace).toBe('tenant-B');

      // Deleting entry in tenant A leaves tenant B untouched
      memStore.delete(entryA.keyHash);
      expect(memStore.get(entryA.keyHash)).toBeUndefined();
      expect(memStore.get(entryB.keyHash)).toBeDefined();
      expect(memStore.get(entryB.keyHash)?.body.toString('utf8')).toBe('settings-for-B');
    });

    it('namespaces are persisted to disk and restored across restart (Feature 29)', () => {
      const diskStore1 = new DiskStore({ dirPath: tempDir });
      const entryAlpha = createDummyEntry('tenant-alpha', '/doc', 'alpha doc content');
      const entryBeta = createDummyEntry('tenant-beta', '/doc', 'beta doc content');

      diskStore1.set(entryAlpha);
      diskStore1.set(entryBeta);

      // Restart DiskStore
      const diskStore2 = new DiskStore({ dirPath: tempDir });
      expect(diskStore2.stats().entries).toBe(2);

      const restoredAlpha = diskStore2.get(entryAlpha.keyHash);
      const restoredBeta = diskStore2.get(entryBeta.keyHash);

      expect(restoredAlpha).toBeDefined();
      expect(restoredAlpha?.namespace).toBe('tenant-alpha');
      expect(restoredAlpha?.body.toString('utf8')).toBe('alpha doc content');

      expect(restoredBeta).toBeDefined();
      expect(restoredBeta?.namespace).toBe('tenant-beta');
      expect(restoredBeta?.body.toString('utf8')).toBe('beta doc content');
    });

    it('provides namespace-aware statistics and querying on MetadataIndex', () => {
      const store = new MemoryStore();
      store.set(createDummyEntry('ns-1', '/p1', 'content-1'));
      store.set(createDummyEntry('ns-1', '/p2', 'content-2'));
      store.set(createDummyEntry('ns-2', '/p1', 'content-3'));

      const index = store.getMetadataIndex();
      expect(index.getByNamespace('ns-1').length).toBe(2);
      expect(index.getByNamespace('ns-2').length).toBe(1);
      expect(index.getByNamespace('ns-nonexistent').length).toBe(0);

      expect(index.getNamespaceStats('ns-1').entries).toBe(2);
      expect(index.getNamespaceStats('ns-2').entries).toBe(1);
    });
  });

  describe('Proxy integration: per-request namespace routing via X-Cache-Namespace header', () => {
    let originRequests = 0;
    let originHeaders: Record<string, any>[] = [];
    let originServer: http.Server;
    let originPort: number;
    let proxyListener: ProxyListener;
    let proxyPort: number;
    const testClock = new FakeClock(1000);
    const store = new MemoryStore();

    beforeEach(async () => {
      originRequests = 0;
      originHeaders = [];
      store.clear();

      originServer = http.createServer((req, res) => {
        originRequests++;
        originHeaders.push(req.headers);
        const nsHeader = req.headers['x-cache-namespace'] || 'none';
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=60',
          ETag: `"${nsHeader}-ver"`,
        });
        res.end(`payload-for-ns-${nsHeader}`);
      });

      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as AddressInfo).port;

      proxyListener = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        store,
        clock: testClock,
        cache: { enabled: true },
      });
      proxyPort = proxyListener.httpPort!;
    });

    afterEach(async () => {
      if (proxyListener) await proxyListener.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('serves separate cache entries for the same URL path across different namespaces', async () => {
      // 1. Request in tenant-A -> MISS, caches in tenant-A
      const resA1 = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        headers: { 'x-cache-namespace': 'tenant-A' },
      });
      expect(resA1.status).toBe(200);
      expect(resA1.headers.get('x-cache')).toBe('MISS');
      expect(await resA1.text()).toBe('payload-for-ns-tenant-A');
      expect(originRequests).toBe(1);

      // 2. Request in tenant-A again -> HIT from tenant-A
      const resA2 = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        headers: { 'x-cache-namespace': 'tenant-A' },
      });
      expect(resA2.status).toBe(200);
      expect(resA2.headers.get('x-cache')).toBe('HIT');
      expect(await resA2.text()).toBe('payload-for-ns-tenant-A');
      expect(originRequests).toBe(1); // origin not called

      // 3. Request for the exact same URL path in tenant-B -> MISS, does not return tenant-A entry
      const resB1 = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        headers: { 'x-cache-namespace': 'tenant-B' },
      });
      expect(resB1.status).toBe(200);
      expect(resB1.headers.get('x-cache')).toBe('MISS');
      expect(await resB1.text()).toBe('payload-for-ns-tenant-B');
      expect(originRequests).toBe(2); // origin called for tenant-B

      // 4. Request in tenant-B again -> HIT from tenant-B
      const resB2 = await fetch(`http://127.0.0.1:${proxyPort}/api/config`, {
        headers: { 'x-cache-namespace': 'tenant-B' },
      });
      expect(resB2.status).toBe(200);
      expect(resB2.headers.get('x-cache')).toBe('HIT');
      expect(await resB2.text()).toBe('payload-for-ns-tenant-B');
      expect(originRequests).toBe(2);

      // Verify store has 2 distinct entries
      expect(store.stats().entries).toBe(2);
    });
  });
});
