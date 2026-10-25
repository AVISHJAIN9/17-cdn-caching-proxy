import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { RevalidationLockManager } from '../src/cache/locks.js';
import { BackgroundRevalidator } from '../src/cache/background.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { SystemClock } from '../src/util/clock.js';
import { CacheEntry } from '../src/cache/store.js';
import { formatHttpDate } from '../src/cache/http-date.js';

describe('Feature 49: Revalidation Locks (src/cache/locks.ts)', () => {
  let lockManager: RevalidationLockManager;

  beforeEach(() => {
    lockManager = new RevalidationLockManager();
  });

  afterEach(() => {
    lockManager.clear();
  });

  it('1. Locks are per-key, not global: keyA and keyB can be acquired concurrently', () => {
    const handleA = lockManager.tryAcquire('key-A');
    expect(handleA).not.toBeNull();
    expect(lockManager.isLocked('key-A')).toBe(true);

    const handleB = lockManager.tryAcquire('key-B');
    expect(handleB).not.toBeNull();
    expect(lockManager.isLocked('key-B')).toBe(true);
    expect(lockManager.activeLocksCount).toBe(2);

    handleA!.release();
    expect(lockManager.isLocked('key-A')).toBe(false);
    expect(lockManager.isLocked('key-B')).toBe(true);

    handleB!.release();
    expect(lockManager.isLocked('key-B')).toBe(false);
    expect(lockManager.activeLocksCount).toBe(0);
  });

  it('2. A second revalidation for the same key never starts while one is running', () => {
    const handle1 = lockManager.tryAcquire('key-shared');
    expect(handle1).not.toBeNull();

    // Second acquire for same key must fail
    const handle2 = lockManager.tryAcquire('key-shared');
    expect(handle2).toBeNull();

    handle1!.release();
    // After release, acquiring succeeds
    const handle3 = lockManager.tryAcquire('key-shared');
    expect(handle3).not.toBeNull();
    handle3!.release();
  });

  it('3. Lock is released on success using withLock', async () => {
    let executed = false;
    const res = await lockManager.withLock('key-success', async () => {
      executed = true;
      return 'ok';
    });

    expect(executed).toBe(true);
    expect(res).toBe('ok');
    expect(lockManager.isLocked('key-success')).toBe(false);
  });

  it('4. Lock is released on error/exception inside withLock', async () => {
    await expect(
      lockManager.withLock('key-fail', async () => {
        throw new Error('origin boom');
      })
    ).rejects.toThrow('origin boom');

    expect(lockManager.isLocked('key-fail')).toBe(false);
  });

  it('5. Lock is released on timeout if revalidation hangs', async () => {
    const handle = lockManager.tryAcquire('key-timeout', { timeoutMs: 50 });
    expect(handle).not.toBeNull();
    expect(lockManager.isLocked('key-timeout')).toBe(true);

    // Wait for timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lockManager.isLocked('key-timeout')).toBe(false);
    // Can now be acquired again
    const handle2 = lockManager.tryAcquire('key-timeout');
    expect(handle2).not.toBeNull();
    handle2!.release();
  });

  it('6. Lock is released on cancellation via AbortSignal', () => {
    const controller = new AbortController();
    const handle = lockManager.tryAcquire('key-cancel', { signal: controller.signal });
    expect(handle).not.toBeNull();
    expect(lockManager.isLocked('key-cancel')).toBe(true);

    controller.abort();
    expect(lockManager.isLocked('key-cancel')).toBe(false);
  });

  describe('Integration with BackgroundRevalidator', () => {
    let originServer: http.Server;
    let originPort: number;
    let store: MemoryStore;
    const clock = new SystemClock();
    let revalidator: BackgroundRevalidator;

    beforeEach(async () => {
      store = new MemoryStore();
      lockManager = new RevalidationLockManager();
      revalidator = new BackgroundRevalidator({
        store,
        clock,
        cacheConfig: { maxTtlMs: 86400000, minTtlMs: 0 },
        lockManager,
      });

      originServer = http.createServer((req, res) => {
        // Will be configured per test
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

    function makeStale(key = '/test'): CacheEntry {
      const now = clock.now();
      const body = Buffer.from('stale');
      const entry: CacheEntry = {
        keyHash: 'hash-' + key,
        keyString: `http://127.0.0.1:${originPort}${key}`,
        originId: 'default',
        status: 200,
        statusMessage: 'OK',
        headers: { 'cache-control': 'max-age=1' },
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
        version: 1,
      };
      store.set(entry);
      return entry;
    }

    it('7. BackgroundRevalidator does not launch concurrent revalidation for same locked key', async () => {
      let requestCount = 0;
      let resolveFirstReq!: () => void;
      const firstReqArrived = new Promise<void>((r) => { resolveFirstReq = r; });
      let finishFirstReq!: () => void;
      const firstReqCanFinish = new Promise<void>((r) => { finishFirstReq = r; });

      originServer.on('request', async (req, res) => {
        requestCount++;
        resolveFirstReq();
        await firstReqCanFinish;
        res.writeHead(304, { 'Date': formatHttpDate(clock.now()) });
        res.end();
      });

      const entry = makeStale('/shared');

      // First revalidation
      const job1 = revalidator.revalidateInBackground({
        staleEntry: entry,
        originUrl: `http://127.0.0.1:${originPort}/shared`,
      });

      await firstReqArrived;
      expect(lockManager.isLocked(entry.keyHash)).toBe(true);

      // Second revalidation attempt for same key while job1 is in-flight
      const job2 = revalidator.revalidateInBackground({
        staleEntry: entry,
        originUrl: `http://127.0.0.1:${originPort}/shared`,
      });

      // job2 returns existing job or skipped without launching 2nd origin request
      expect(job2).toBe(job1);

      finishFirstReq();
      await job1;

      expect(requestCount).toBe(1);
      expect(lockManager.isLocked(entry.keyHash)).toBe(false);
    });
  });
});
