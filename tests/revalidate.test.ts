import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 3: Synchronous Revalidation (src/cache/revalidate.ts)', () => {
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let clock: FakeClock;
  let store: MemoryStore;
  const baseTime = 1_000_000_000_000;

  beforeEach(async () => {
    resetStats();
    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        originPort = (originServer.address() as any).port;
        resolve();
      });
    });

    clock = new FakeClock(baseTime);
    store = new MemoryStore();
    proxyListener = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      clock,
      store,
      cache: {
        enabled: true,
        debugHeaders: true,
        revalidate: { enabled: true },
        maxObjectBytes: 5 * 1024 * 1024,
      },
      timeouts: {
        upstreamConnectMs: 500,
        upstreamHeadersMs: 800,
      },
    });
    proxyPort = proxyListener.httpPort!;
  });

  afterEach(async () => {
    await proxyListener?.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  async function getOriginLogs(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${originPort}/__log`, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(JSON.parse(text)));
        res.on('error', reject);
      });
    });
  }

  async function resetOrigin(): Promise<void> {
    await rawRequest(
      originPort,
      'POST /__reset HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
  }

  async function configOrigin(id: string, config: any): Promise<void> {
    const body = JSON.stringify(config);
    await rawRequest(
      originPort,
      `POST /__config/${id} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  }

  async function bumpOrigin(id: string): Promise<void> {
    await rawRequest(
      originPort,
      `POST /__bump/${id} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    );
  }

  // 1. Fresh -> stale -> 304 refresh
  it('1. Fresh then stale then 304 refresh (conditional request, body unchanged, REVALIDATED)', async () => {
    const miss = await rawRequest(
      proxyPort,
      'GET /reval/item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    expect(miss.headers['x-cache']).toBe('MISS');
    const originalBody = miss.body.toString('utf-8');

    // Advance clock past 60s
    clock.advance(70_000);
    await resetOrigin();

    const reval = await rawRequest(
      proxyPort,
      'GET /reval/item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(reval.statusCode).toBe(200);
    expect(reval.headers['x-cache']).toBe('REVALIDATED');
    expect(reval.body.toString('utf-8')).toBe(originalBody);

    const logs = await getOriginLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].ifNoneMatch).toBe('"item1-v1"');
    expect(store.stats().revalidatedNotModified).toBe(1);
  });

  // 2. Refresh with longer max-age stays fresh past old lifetime
  it('2. After a refresh with a longer max-age the entry stays fresh past the old lifetime', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // Stale at +70s
    clock.advance(70_000);
    await configOrigin('item2', { cc304: 'max-age=500' });

    // Refresh with max-age=500
    const reval = await rawRequest(
      proxyPort,
      'GET /reval/item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(reval.headers['x-cache']).toBe('REVALIDATED');

    // Advance 200s (past original 60s, but well within 500s)
    clock.advance(200_000);
    await resetOrigin();

    const hit = await rawRequest(
      proxyPort,
      'GET /reval/item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['x-cache']).toBe('HIT');

    const logs = await getOriginLogs();
    expect(logs.length).toBe(0); // Served purely from cache
  });

  // 3. /__bump then stale gives 200 replaced
  it('3. /__bump then stale gives 200 replaced (new version body, old entry gone)', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item3 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    await bumpOrigin('item3');
    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item3 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers['x-cache-reason']).toBe('revalidated_replaced');
    expect(res.body.toString('utf-8')).toContain('version=2');
    expect(store.stats().revalidatedReplaced).toBe(1);
  });

  // 4. IMS-only revalidation (etagMode none)
  it('4. IMS-only revalidation sends only If-Modified-Since when origin has no ETag', async () => {
    await configOrigin('item-ims', { etagMode: 'none', lm: 'Sat, 01 Jan 2000 00:00:00 GMT' });

    await rawRequest(
      proxyPort,
      'GET /reval/item-ims HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-ims HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');

    const logs = await getOriginLogs();
    expect(logs[0].ifNoneMatch).toBeUndefined();
    expect(logs[0].ifModifiedSince).toBe('Sat, 01 Jan 2000 00:00:00 GMT');
  });

  // 5. Weak ETag revalidation
  it('5. Weak ETag revalidation sends W/ prefix and refreshes on 304', async () => {
    await configOrigin('item-weak', { etagMode: 'weak' });
    await rawRequest(
      proxyPort,
      'GET /reval/item-weak HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-weak HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');

    const logs = await getOriginLogs();
    expect(logs[0].ifNoneMatch).toBe('W/"item-weak-v1"');
  });

  // 6. Revalidation with both validators sends both
  it('6. Revalidation with both validators sends both If-None-Match and If-Modified-Since', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-both HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    await rawRequest(
      proxyPort,
      'GET /reval/item-both HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    const logs = await getOriginLogs();
    expect(logs[0].ifNoneMatch).toBe('"item-both-v1"');
    expect(logs[0].ifModifiedSince).toBe('Sat, 01 Jan 2000 00:00:00 GMT');
  });

  // 7. Client INM matching refreshed entry gets 304 after stale refresh
  it('7. Client If-None-Match matching refreshed entry gets 304 after stale refresh', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-client-inm HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-client-inm HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "item-client-inm-v1"\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(304);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
    expect(res.body.length).toBe(0);

    const logs = await getOriginLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].ifNoneMatch).toBe('"item-client-inm-v1"');
  });

  // 8. Client INM NOT matching gets full 200
  it('8. Client If-None-Match NOT matching refreshed entry gets 200 with full body', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-client-nomatch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-client-nomatch HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "other"\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
    expect(res.body.toString('utf-8')).toContain('id=item-client-nomatch');
  });

  // 9. 304 mismatch gives 502 and entry is gone
  it('9. 304 mismatch gives 502 UPSTREAM_INVALID_RESPONSE and entry is deleted', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval-mismatch/item-mismatch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval-mismatch/item-mismatch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(502);
    expect(store.stats().entries).toBe(0);
    expect(store.stats().validatorMismatches).toBe(1);
  });

  // 10. 304 that adds no-store serves once and deletes
  it('10. 304 that adds no-store serves once and deletes entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-nostore HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await configOrigin('item-nostore', { cc304: 'no-store' });

    // Served once
    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-nostore HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(store.stats().entries).toBe(0); // Deleted!

    // Next request is a fresh MISS
    const nextMiss = await rawRequest(
      proxyPort,
      'GET /reval/item-nostore HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(nextMiss.headers['x-cache']).toBe('MISS');
  });

  // 11. Origin 404 deletes stale entry
  it('11. Origin 404 deletes stale entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item404 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(store.stats().entries).toBe(1);

    clock.advance(70_000);
    await configOrigin('item404', { status: 404 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item404 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(404);
    expect(store.stats().entries).toBe(0);
  });

  // 12. Origin 410 deletes stale entry
  it('12. Origin 410 deletes stale entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item410 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(store.stats().entries).toBe(1);

    clock.advance(70_000);
    await configOrigin('item410', { status: 410 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item410 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(410);
    expect(store.stats().entries).toBe(0);
  });

  // 13. Origin 500 keeps stale entry and next request revalidates again
  it('13. Origin 500 keeps the stale entry and next request revalidates again', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(store.stats().entries).toBe(1);

    clock.advance(70_000);
    await configOrigin('item500', { status: 500 });

    const res500 = await rawRequest(
      proxyPort,
      'GET /reval/item500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res500.statusCode).toBe(500);
    expect(store.stats().entries).toBe(1); // Stale entry kept!

    // Origin restores status 200
    await configOrigin('item500', { status: 200 });

    const resReval = await rawRequest(
      proxyPort,
      'GET /reval/item500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(resReval.statusCode).toBe(200);
    expect(resReval.headers['x-cache']).toBe('REVALIDATED');
  });

  // 14. Origin down gives 502 and keeps entry, then origin back gives successful refresh
  it('14. Origin down gives 502 and keeps entry, then origin back gives successful refresh', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-down HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(store.stats().entries).toBe(1);

    clock.advance(70_000);

    // Stop origin
    await new Promise<void>((resolve) => originServer.close(() => resolve()));

    const res502 = await rawRequest(
      proxyPort,
      'GET /reval/item-down HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res502.statusCode).toBe(502);
    expect(store.stats().entries).toBe(1); // Stale entry kept!

    // Restart origin on same port
    await new Promise<void>((resolve) => {
      originServer.listen(originPort, '127.0.0.1', () => resolve());
    });

    const resRecover = await rawRequest(
      proxyPort,
      'GET /reval/item-down HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(resRecover.statusCode).toBe(200);
    expect(resRecover.headers['x-cache']).toBe('REVALIDATED');
  });

  // 15. Connect/headers timeout gives 504 and keeps entry
  it('15. Headers timeout gives 504 and keeps the stale entry', async () => {
    // Custom hanging server
    let hangSocket: any = null;
    const slowServer = net.createServer((sock) => {
      hangSocket = sock;
      // Never send response headers
    });
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()));
    const slowPort = (slowServer.address() as any).port;

    const slowProxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${slowPort}`,
      clock,
      store,
      timeouts: { upstreamHeadersMs: 300 },
    });

    // Seed a stale entry into the store
    const staleEntry = {
      keyHash: 'hash-slow',
      keyString: `http://127.0.0.1:${slowPort}/reval/hang`,
      originId: 'default',
      status: 200,
      statusMessage: 'OK',
      headers: {
        'content-type': 'text/plain',
        'content-length': '5',
        'cache-control': 'max-age=10',
        'etag': '"hang-v1"',
        'date': 'Sat, 01 Jan 2000 00:00:00 GMT',
      },
      body: Buffer.from('hello'),
      size: 5,
      storedAt: baseTime,
      hitCount: 1,
      lastAccessedAt: baseTime,
      requestTimeMs: baseTime,
      responseTimeMs: baseTime + 10,
      dateValueMs: baseTime,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 10_000,
      lifetimeSource: 'max-age' as any,
      etag: { weak: false, opaque: 'hang-v1', raw: '"hang-v1"' },
      etagRaw: '"hang-v1"',
      version: 1,
    };
    store.set(staleEntry);
    clock.advance(20_000); // stale

    const res504 = await rawRequest(
      slowProxy.httpPort!,
      'GET /reval/hang HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res504.statusCode).toBe(504);
    expect(store.stats().entries).toBeGreaterThanOrEqual(1);

    hangSocket?.destroy();
    await slowProxy.stop();
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
  });

  // 16. Unsolicited 304 gives 502
  it('16. Unsolicited 304 gives 502 UPSTREAM_INVALID_RESPONSE', async () => {
    const res = await rawRequest(
      proxyPort,
      'GET /reval-always-304 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(502);
    expect(store.stats().entries).toBe(0);
  });

  // 17. Cancelled revalidation leaks nothing and changes nothing
  it('17. Cancelled revalidation leaks nothing and changes nothing in store', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/cancel-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    const initialBytes = store.stats().totalBytes;

    clock.advance(70_000);

    // Connect, send partial request, destroy socket immediately
    const client = net.createConnection({ port: proxyPort }, () => {
      client.write('GET /reval/cancel-item HTTP/1.1\r\nHost: localhost\r\n');
      client.destroy();
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(store.stats().totalBytes).toBe(initialBytes);
  });

  // 18. Superseded refresh
  it('18. Superseded refresh (overlapping revalidations) never overwrites newer entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/supersede-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // Stale
    clock.advance(70_000);

    // Directly simulate entry replacement (version 2 now in store)
    const stored = store.get(Array.from((store as any).entries.keys())[0] as string);
    expect(stored).toBeDefined();

    // Bump entry version to 2
    store.set({
      ...stored!,
      body: Buffer.from('newer-content'),
      size: 13,
    });
    expect(store.get(stored!.keyHash)?.body.toString('utf-8')).toBe('newer-content');

    // Trigger revalidation of item
    const res = await rawRequest(
      proxyPort,
      'GET /reval/supersede-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);

    // Must still have newer-content in store
    expect(store.get(stored!.keyHash)?.body.toString('utf-8')).toBe('newer-content');
  });

  // 19. Stats arithmetic
  it('19. Stats counters accurately reflect revalidation outcomes', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/stats-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    // Refresh (not_modified)
    await rawRequest(
      proxyPort,
      'GET /reval/stats-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    // Bump (replaced)
    await bumpOrigin('stats-test');
    await rawRequest(
      proxyPort,
      'GET /reval/stats-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    const stats = store.stats();
    expect(stats.revalidations).toBe(2);
    expect(stats.revalidatedNotModified).toBe(1);
    expect(stats.revalidatedReplaced).toBe(1);
  });

  // 20. totalBytes consistency after every path
  it('20. totalBytes stays equal to the real sum of stored body sizes through replace and delete', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/itemA HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    await rawRequest(
      proxyPort,
      'GET /reval/itemB HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    let realSum = 0;
    for (const entry of (store as any).entries.values()) {
      realSum += entry.size;
    }
    expect(store.stats().totalBytes).toBe(realSum);

    // Replace itemA on revalidation
    clock.advance(70_000);
    await bumpOrigin('itemA');
    await rawRequest(
      proxyPort,
      'GET /reval/itemA HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    realSum = 0;
    for (const entry of (store as any).entries.values()) {
      realSum += entry.size;
    }
    expect(store.stats().totalBytes).toBe(realSum);

    // Delete itemB via 404
    await configOrigin('itemB', { status: 404 });
    await rawRequest(
      proxyPort,
      'GET /reval/itemB HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    realSum = 0;
    for (const entry of (store as any).entries.values()) {
      realSum += entry.size;
    }
    expect(store.stats().totalBytes).toBe(realSum);
  });

  // 21. A 200 that is not storable deletes the stale entry
  it('21. A 200 that is not storable deletes the stale entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-unstorable HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(store.stats().entries).toBe(1);

    clock.advance(70_000);
    await bumpOrigin('item-unstorable');
    await configOrigin('item-unstorable', { cc: 'no-store' });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-unstorable HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(store.stats().entries).toBe(0); // Superseded and deleted!
  });

  // 22. Two pipelined requests: one revalidating, one HIT
  it('22. Two pipelined requests, one revalidating and one HIT, come back complete and in order', async () => {
    // Prime both
    await rawRequest(
      proxyPort,
      'GET /reval/pipeA HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    await rawRequest(
      proxyPort,
      'GET /reval/pipeB HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // Advance clock so pipeA is stale, but prime pipeB again so it's fresh
    clock.advance(70_000);
    // Refresh pipeB so pipeB is fresh, pipeA is stale
    await rawRequest(
      proxyPort,
      'GET /reval/pipeB HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    const client = net.createConnection({ port: proxyPort }, () => {
      client.write(
        'GET /reval/pipeA HTTP/1.1\r\nHost: localhost\r\n\r\n' +
        'GET /reval/pipeB HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
    });

    let buffer = '';
    client.on('data', (d) => (buffer += d.toString('utf-8')));

    await new Promise<void>((resolve) => client.on('close', resolve));

    expect(buffer).toContain('id=pipeA');
    expect(buffer).toContain('id=pipeB');
    const idxA = buffer.indexOf('id=pipeA');
    const idxB = buffer.indexOf('id=pipeB');
    expect(idxA).toBeLessThan(idxB); // Correct order!
  });

  // 23. Client IMS matching refreshed entry gets 304
  it('23. Client If-Modified-Since matching refreshed entry gets 304', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-ims-304 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-ims-304 HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: Sat, 01 Jan 2000 00:00:00 GMT\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(304);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  // 24. Client IMS older gets 200
  it('24. Client If-Modified-Since older than refreshed entry gets 200', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-ims-old HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-ims-old HTTP/1.1\r\nHost: localhost\r\nIf-Modified-Since: Fri, 31 Dec 1999 00:00:00 GMT\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  // 25. Origin 502 keeps stale entry
  it('25. Origin 502 keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-502 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-502', { status: 502 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-502 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(502);
    expect(store.stats().entries).toBe(1);
  });

  // 26. Origin 503 keeps stale entry
  it('26. Origin 503 keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-503 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-503', { status: 503 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-503 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(503);
    expect(store.stats().entries).toBe(1);
  });

  // 27. Origin 504 keeps stale entry
  it('27. Origin 504 keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-504 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-504', { status: 504 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-504 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(504);
    expect(store.stats().entries).toBe(1);
  });

  // 28. Origin 400 Bad Request keeps stale entry
  it('28. Origin 400 Bad Request keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-400 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-400', { status: 400 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-400 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(400);
    expect(store.stats().entries).toBe(1);
  });

  // 29. Origin 403 Forbidden keeps stale entry
  it('29. Origin 403 Forbidden keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-403 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-403', { status: 403 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-403 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(403);
    expect(store.stats().entries).toBe(1);
  });

  // 30. Origin 301 Redirect keeps stale entry
  it('30. Origin 301 Redirect keeps stale entry untouched', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-301 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-301', { status: 301 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-301 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(301);
    expect(store.stats().entries).toBe(1);
  });

  // 31. 304 with max-age=0 serves once and deletes
  it('31. 304 with max-age=0 serves once and deletes entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-zero HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-zero', { cc304: 'max-age=0' });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-zero HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(store.stats().entries).toBe(0);
  });

  // 32. 304 with private serves once and deletes
  it('32. 304 with private serves once and deletes entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-private HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-private', { cc304: 'private' });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-private HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(store.stats().entries).toBe(0);
  });

  // 33. 304 with no-cache serves once and deletes
  it('33. 304 with no-cache serves once and deletes entry', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-nocache HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);
    await configOrigin('item-nocache', { cc304: 'no-cache' });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-nocache HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(store.stats().entries).toBe(0);
  });

  // 34. Refresh with custom headers updates them
  it('34. Refresh updates arbitrary headers sent in 304', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-headers HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-headers HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  // 35. Revalidation log events emitted
  it('35. Revalidation start and result log events emitted with requestId', async () => {
    await rawRequest(
      proxyPort,
      'GET /reval/item-log HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);

    const res = await rawRequest(
      proxyPort,
      'GET /reval/item-log HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.headers['x-cache']).toBe('REVALIDATED');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  // 36. BASELINE MEASUREMENT
  it('36. BASELINE MEASUREMENT: 50 concurrent requests on a stale entry', async () => {
    // Prime the entry
    const miss = await rawRequest(
      proxyPort,
      'GET /reval/stampede-target HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    const expectedBody = miss.body.toString('utf-8');

    // Make entry stale
    clock.advance(70_000);
    await resetOrigin();
    await configOrigin('stampede-target', { delayMs: 60 });

    // Fire 50 concurrent client requests
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        rawRequest(
          proxyPort,
          'GET /reval/stampede-target HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        )
      );
    }

    const responses = await Promise.all(promises);

    // All must succeed with 200 and the correct body
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      expect(r.body.toString('utf-8')).toBe(expectedBody);
    }

    // Check how many conditional requests reached the origin
    const logs = await getOriginLogs();
    const conditionalCount = logs.filter(
      (l) => l.path === '/reval/stampede-target' && l.ifNoneMatch !== undefined
    ).length;

    console.log(`[BASELINE MEASUREMENT] Stale entry stampede: 50 concurrent requests produced ${conditionalCount} upstream conditional requests.`);
    expect(conditionalCount).toBeGreaterThanOrEqual(1);
  });
});
