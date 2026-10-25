import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/cache/memory-store.js';
import { CacheEntry } from '../src/cache/store.js';
import { SystemClock } from '../src/util/clock.js';
import { parseEntityTag } from '../src/cache/etag.js';
import { formatHttpDate } from '../src/cache/http-date.js';
import {
  BackgroundRevalidator,
  BackgroundJobOptions,
} from '../src/cache/background.js';

describe('Feature 41: Background Revalidation (src/cache/background.ts)', () => {
  let originServer: http.Server;
  let originPort: number;
  let originHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let store: MemoryStore;
  const clock = new SystemClock();
  let revalidator: BackgroundRevalidator;

  beforeEach(async () => {
    store = new MemoryStore();
    revalidator = new BackgroundRevalidator({
      store,
      clock,
      cacheConfig: {
        maxTtlMs: 86400000,
        minTtlMs: 0,
      },
    });

    originServer = http.createServer((req, res) => {
      if (originHandler) {
        originHandler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        originPort = (originServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  function createStaleEntry(path = '/resource', overrides: Partial<CacheEntry> = {}): CacheEntry {
    const body = Buffer.from('stale version 1');
    const now = clock.now();
    const entry: CacheEntry = {
      keyHash: 'hash-' + path,
      keyString: `http://127.0.0.1:${originPort}${path}`,
      originId: 'default',
      status: 200,
      statusMessage: 'OK',
      headers: {
        'content-type': 'text/plain',
        'content-length': body.length.toString(),
        'cache-control': 'max-age=1',
        'etag': '"etag-v1"',
        'last-modified': formatHttpDate(now - 10000),
        'date': formatHttpDate(now - 2000),
      },
      body,
      size: body.length,
      storedAt: now - 2000,
      hitCount: 1,
      lastAccessedAt: now - 1000,
      requestTimeMs: now - 2000,
      responseTimeMs: now - 1990,
      dateValueMs: now - 2000,
      ageValueSeconds: 2,
      freshnessLifetimeMs: 1000,
      lifetimeSource: 'max-age',
      etag: parseEntityTag('"etag-v1"')!,
      etagRaw: '"etag-v1"',
      lastModifiedMs: now - 10000,
      lastModifiedRaw: formatHttpDate(now - 10000),
      version: 1,
      ...overrides,
    };
    store.set(entry);
    return entry;
  }

  it('1. Sends conditional GET with If-None-Match and If-Modified-Since upstream', async () => {
    let capturedHeaders: http.IncomingHttpHeaders | null = null;
    originHandler = (req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(304, {
        'ETag': '"etag-v1"',
        'Cache-Control': 'max-age=120',
        'Date': formatHttpDate(clock.now()),
      });
      res.end();
    };

    const staleEntry = createStaleEntry('/test-headers');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/test-headers`,
    });

    const result = await job;
    expect(result.status).toBe(304);
    expect(result.outcome).toBe('refreshed');
    expect(capturedHeaders!['if-none-match']).toBe('"etag-v1"');
    expect(capturedHeaders!['if-modified-since']).toBe(staleEntry.lastModifiedRaw);
  });

  it('2. 304 response refreshes headers and freshness in store without modifying body', async () => {
    originHandler = (req, res) => {
      res.writeHead(304, {
        'ETag': '"etag-v1"',
        'Cache-Control': 'max-age=300',
        'X-Custom-Header': 'refreshed-val',
        'Date': formatHttpDate(clock.now()),
      });
      res.end();
    };

    const staleEntry = createStaleEntry('/refresh');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/refresh`,
    });

    const result = await job;
    expect(result.outcome).toBe('refreshed');

    const updated = store.get(staleEntry.keyHash);
    expect(updated).toBeDefined();
    expect(updated!.headers['cache-control']).toBe('max-age=300');
    expect(updated!.headers['x-custom-header']).toBe('refreshed-val');
    expect(updated!.freshnessLifetimeMs).toBe(300_000);
    expect(updated!.body.toString()).toBe('stale version 1');
  });

  it('3. 200 response replaces stale entry with new body and headers', async () => {
    originHandler = (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'ETag': '"etag-v2"',
        'Cache-Control': 'max-age=600',
        'Date': formatHttpDate(clock.now()),
      });
      res.end('fresh version 2 body');
    };

    const staleEntry = createStaleEntry('/replace');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/replace`,
    });

    const result = await job;
    expect(result.status).toBe(200);
    expect(result.outcome).toBe('replaced');

    const updated = store.get(staleEntry.keyHash);
    expect(updated).toBeDefined();
    expect(updated!.etagRaw).toBe('"etag-v2"');
    expect(updated!.body.toString()).toBe('fresh version 2 body');
    expect(updated!.freshnessLifetimeMs).toBe(600_000);
  });

  it('4. 404 or 410 deletes the stale entry from store', async () => {
    originHandler = (req, res) => {
      res.writeHead(404, { 'Date': formatHttpDate(clock.now()) });
      res.end('Not Found');
    };

    const staleEntry = createStaleEntry('/not-found');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/not-found`,
    });

    const result = await job;
    expect(result.status).toBe(404);
    expect(result.outcome).toBe('deleted');

    expect(store.get(staleEntry.keyHash)).toBeUndefined();
  });

  it('5. 5xx response leaves stale entry untouched in the store', async () => {
    originHandler = (req, res) => {
      res.writeHead(500, { 'Date': formatHttpDate(clock.now()) });
      res.end('Internal Error');
    };

    const staleEntry = createStaleEntry('/server-error');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/server-error`,
    });

    const result = await job;
    expect(result.status).toBe(500);
    expect(result.outcome).toBe('preserved');

    const entryInStore = store.get(staleEntry.keyHash);
    expect(entryInStore).toBeDefined();
    expect(entryInStore!.body.toString()).toBe('stale version 1');
  });

  it('6. Network connection failure is handled gracefully without throwing unhandled rejection', async () => {
    const staleEntry = createStaleEntry('/bad-port');
    // Port 1 is closed
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: 'http://127.0.0.1:1/bad-port',
    });

    const result = await job;
    expect(result.outcome).toBe('error');
    expect(store.get(staleEntry.keyHash)).toBeDefined();
  });

  it('7. Tracks active background jobs and cleans up when finished', async () => {
    let resolveReqArrived!: () => void;
    const reqArrived = new Promise<void>((r) => {
      resolveReqArrived = r;
    });
    let sendResponse!: () => void;
    const responseReady = new Promise<void>((r) => {
      sendResponse = r;
    });

    originHandler = async (req, res) => {
      resolveReqArrived();
      await responseReady;
      res.writeHead(304, { 'Date': formatHttpDate(clock.now()) });
      res.end();
    };

    const staleEntry = createStaleEntry('/track-jobs');
    const job = revalidator.revalidateInBackground({
      staleEntry,
      originUrl: `http://127.0.0.1:${originPort}/track-jobs`,
    });

    expect(revalidator.activeJobsCount).toBe(1);
    expect(revalidator.hasActiveJob(staleEntry.keyHash)).toBe(true);

    await reqArrived;
    sendResponse();
    await job;

    expect(revalidator.activeJobsCount).toBe(0);
    expect(revalidator.hasActiveJob(staleEntry.keyHash)).toBe(false);
  });
});
