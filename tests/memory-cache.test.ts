import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { MemoryStore } from '../src/cache/memory-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { FakeClock } from '../src/util/clock.js';

function createDummyEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const body = overrides.body ?? Buffer.from('hello memory cache');
  return {
    keyHash: 'hash-abc-123',
    keyString: 'GET https://example.com/data',
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

describe('Feature 27: Memory cache', () => {
  describe('MemoryStore unit operations', () => {
    it('performs store, get, and delete round-trip', () => {
      const store = new MemoryStore();
      const entry = createDummyEntry({ keyHash: 'entry-1', body: Buffer.from('round-trip test') });

      expect(store.get('entry-1')).toBeUndefined();

      const stored = store.set(entry);
      expect(stored).toBe(true);

      const retrieved = store.get('entry-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.keyHash).toBe('entry-1');
      expect(retrieved?.status).toBe(200);
      expect(retrieved?.body.toString('utf8')).toBe('round-trip test');
      expect(retrieved?.headers['content-type']).toBe('text/plain');

      const deleted = store.delete('entry-1');
      expect(deleted).toBe(true);
      expect(store.get('entry-1')).toBeUndefined();

      // Deleting again returns false
      expect(store.delete('entry-1')).toBe(false);
    });

    it('overwrites an existing entry replacing it cleanly and updating totalBytes', () => {
      const store = new MemoryStore();
      const entryA = createDummyEntry({ keyHash: 'entry-dup', body: Buffer.from('Initial short') });
      const entryB = createDummyEntry({
        keyHash: 'entry-dup',
        body: Buffer.from('Replacement much longer body content'),
        headers: { 'content-type': 'text/html' },
      });

      expect(store.set(entryA)).toBe(true);
      expect(store.stats().entries).toBe(1);
      expect(store.stats().totalBytes).toBe(entryA.size);

      expect(store.set(entryB)).toBe(true);
      expect(store.stats().entries).toBe(1);
      expect(store.stats().totalBytes).toBe(entryB.size);

      const retrieved = store.get('entry-dup');
      expect(retrieved?.body.toString('utf8')).toBe('Replacement much longer body content');
      expect(retrieved?.headers['content-type']).toBe('text/html');
    });

    it('returns nothing on cache miss and records stats', () => {
      const store = new MemoryStore();
      expect(store.get('non-existent-hash')).toBeUndefined();

      store.recordMiss();
      expect(store.stats().misses).toBe(1);
    });

    it('returns defensive copies so mutating retrieved entry does not corrupt store', () => {
      const store = new MemoryStore();
      const entry = createDummyEntry({ keyHash: 'immutable-check', body: Buffer.from('original') });
      store.set(entry);

      const got1 = store.get('immutable-check')!;
      got1.body[0] = 0x58; // mutate buffer
      (got1.headers as any)['content-type'] = 'application/json';

      const got2 = store.get('immutable-check')!;
      expect(got2.body.toString('utf8')).toBe('original');
      expect(got2.headers['content-type']).toBe('text/plain');
    });
  });

  describe('Proxy integration: wiring into cache lookup, hit, miss, and store paths', () => {
    let originServer: http.Server;
    let originPort: number;
    let proxyListener: ProxyListener;
    let proxyPort: number;
    let originRequestCount = 0;
    const testClock = new FakeClock(1000);
    const store = new MemoryStore();

    beforeAll(async () => {
      originServer = http.createServer((req, res) => {
        originRequestCount++;
        if (req.url === '/data') {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'max-age=60',
            ETag: '"ver-1"',
          });
          res.end('origin-payload-data');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        }
      });

      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as AddressInfo).port;

      proxyListener = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        store,
        clock: testClock,
        cache: {
          enabled: true,
          debugHeaders: true,
        },
      });

      proxyPort = proxyListener.httpPort!;
    });

    afterAll(async () => {
      if (proxyListener) {
        await proxyListener.stop();
      }
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('flows through proxy: miss populates memory store, second request hits memory store', async () => {
      originRequestCount = 0;

      // 1. First request -> MISS, populated into memory store
      const res1 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
      expect(res1.status).toBe(200);
      expect(res1.headers.get('x-cache')).toBe('MISS');
      const text1 = await res1.text();
      expect(text1).toBe('origin-payload-data');
      expect(originRequestCount).toBe(1);

      // Verify entry exists in store
      expect(store.stats().entries).toBe(1);
      expect(store.stats().totalBytes).toBeGreaterThan(0);

      // 2. Second request -> HIT, served from memory store
      const res2 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
      expect(res2.status).toBe(200);
      expect(res2.headers.get('x-cache')).toBe('HIT');
      const text2 = await res2.text();
      expect(text2).toBe('origin-payload-data');
      expect(originRequestCount).toBe(1); // origin was NOT called again

      // 3. Clear store, third request -> MISS again
      store.clear();
      expect(store.stats().entries).toBe(0);

      const res3 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
      expect(res3.status).toBe(200);
      expect(res3.headers.get('x-cache')).toBe('MISS');
      const text3 = await res3.text();
      expect(text3).toBe('origin-payload-data');
      expect(originRequestCount).toBe(2); // origin hit again
    });
  });
});
