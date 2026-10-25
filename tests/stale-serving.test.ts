import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';
import { allowsStaleServing } from '../src/cache/stale.js';
import { serveCacheStale } from '../src/cache/serve.js';
import { CacheEntry } from '../src/cache/store.js';

describe('Feature 44: Stale serving (RFC 9111 Section 4.2.4 & RFC 5861)', () => {
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

  async function configOrigin(id: string, patch: Record<string, any>): Promise<void> {
    const body = JSON.stringify(patch);
    await rawRequest(
      originPort,
      `POST /__config/${id} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  }

  it('1. serveCacheStale sets status, Age, Via, X-Cache: STALE, and optional Warning header', async () => {
    const entry: CacheEntry = {
      keyHash: 'dummyhash',
      keyString: 'dummystring',
      originId: 'default',
      status: 200,
      statusMessage: 'OK',
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'max-age=60',
        'etag': '"v1"',
        'date': 'Sun, 06 Nov 1994 08:49:37 GMT',
      },
      body: Buffer.from('stale payload content'),
      size: 21,
      storedAt: baseTime,
      hitCount: 1,
      lastAccessedAt: baseTime,
      requestTimeMs: baseTime,
      responseTimeMs: baseTime + 10,
      dateValueMs: baseTime,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 60_000,
      lifetimeSource: 'max-age',
      etag: { opaque: 'v1', weak: false, raw: '"v1"' },
      etagRaw: '"v1"',

    };

    clock.advance(150_000); // 150 seconds later

    let writtenHeaders: any = {};
    let writtenStatus = 0;
    let writtenBody = '';

    const mockRes: any = {
      sendDate: false,
      headersSent: false,
      writeHead(status: number, statusMsgOrHeaders?: any, headers?: any) {
        writtenStatus = status;
        writtenHeaders = headers ?? statusMsgOrHeaders;
      },
      write(chunk: any) {
        writtenBody += chunk.toString();
        return true;
      },
      end(chunk?: any) {
        if (chunk) writtenBody += chunk.toString();
      },
      getHeader() {
        return undefined;
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
      emit() {
        return false;
      },
    };

    await serveCacheStale({
      entry,
      clientRes: mockRes,
      clock,
      debugHeaders: true,
      reason: 'test_reason',
      warning: '110 - "Response is Stale"',
    });

    expect(writtenStatus).toBe(200);
    expect(writtenBody).toBe('stale payload content');
    expect(writtenHeaders['x-cache']).toBe('STALE');
    expect(writtenHeaders['x-cache-reason']).toBe('test_reason');
    expect(writtenHeaders['warning']).toBe('110 - "Response is Stale"');
    expect(writtenHeaders['content-length']).toBe(21);
    expect(writtenHeaders['transfer-encoding']).toBeUndefined();
    expect(writtenHeaders['via']).toContain('1.1 cdn-proxy');
    expect(Number(writtenHeaders['age'])).toBeGreaterThanOrEqual(150);
    expect(writtenHeaders['date']).toBe('Sun, 06 Nov 1994 08:49:37 GMT');
  });

  it('2. allowsStaleServing strictly enforces never-stale on must-revalidate, proxy-revalidate, s-maxage', () => {
    const makeEntry = (cc: string): CacheEntry => ({
      keyHash: 'hash',
      keyString: 'str',
      originId: 'default',
      status: 200,
      statusMessage: 'OK',
      headers: { 'cache-control': cc },
      body: Buffer.from('hi'),
      size: 2,
      storedAt: baseTime,
      hitCount: 0,
      lastAccessedAt: baseTime,
      requestTimeMs: baseTime,
      responseTimeMs: baseTime,
      dateValueMs: baseTime,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 60_000,
      lifetimeSource: 'max-age',
    });

    expect(allowsStaleServing(makeEntry('max-age=60, must-revalidate, stale-while-revalidate=300'))).toBe(false);
    expect(allowsStaleServing(makeEntry('max-age=60, proxy-revalidate, stale-while-revalidate=300'))).toBe(false);
    expect(allowsStaleServing(makeEntry('s-maxage=60, stale-while-revalidate=300'))).toBe(false);
    expect(allowsStaleServing(makeEntry('max-age=60, must-revalidate, stale-if-error=300'))).toBe(false);
    expect(allowsStaleServing(makeEntry('max-age=60'))).toBe(false);
    expect(allowsStaleServing(makeEntry('max-age=60, stale-while-revalidate=300'))).toBe(true);
    expect(allowsStaleServing(makeEntry('max-age=60, stale-if-error=300'))).toBe(true);
  });

  it('3. Answers client conditional If-None-Match with 304 when serving stale', async () => {
    await configOrigin('stale-cond', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });

    // 1. Prime cache
    const miss = await rawRequest(
      proxyPort,
      'GET /reval/stale-cond HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    const etag = miss.headers['etag'];
    expect(etag).toBeDefined();

    // 2. Advance into stale window
    clock.advance(70_000);

    // 3. Client sends conditional request with matching ETag
    const stale304 = await rawRequest(
      proxyPort,
      `GET /reval/stale-cond HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: ${etag}\r\nConnection: close\r\n\r\n`
    );
    expect(stale304.statusCode).toBe(304);
    expect(stale304.headers['x-cache']).toBe('STALE');
    expect(stale304.headers['x-cache-reason']).toBe('stale_while_revalidate');
    expect(stale304.body.length).toBe(0);

    // 4. Mismatched ETag on another primed stale entry receives full stale 200 body
    await configOrigin('stale-cond-mismatch', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });
    await rawRequest(
      proxyPort,
      'GET /reval/stale-cond-mismatch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    clock.advance(70_000);

    const stale200 = await rawRequest(
      proxyPort,
      'GET /reval/stale-cond-mismatch HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "mismatch-tag"\r\nConnection: close\r\n\r\n'
    );
    expect(stale200.statusCode).toBe(200);
    expect(stale200.headers['x-cache']).toBe('STALE');
    expect(stale200.body.length).toBeGreaterThan(0);
  });

  it('4. Repeated stale serving leaves stored cache entry completely immutable', async () => {
    await configOrigin('stale-immut', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });


    await rawRequest(
      proxyPort,
      'GET /reval/stale-immut HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    // Origin fails on background revalidation so entry remains stale without refresh
    await configOrigin('stale-immut', { status: 500 });

    const initialEntry = store.get(store.stats().entries > 0 ? (Array.from((store as any).entries.keys())[0] as string) : '');

    expect(initialEntry).toBeDefined();
    const originalBodyHex = initialEntry!.body.toString('hex');
    const originalHeaders = JSON.stringify(initialEntry!.headers);

    // Fire 5 sequential stale requests
    for (let i = 0; i < 5; i++) {
      const res = await rawRequest(
        proxyPort,
        'GET /reval/stale-immut HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('STALE');
    }

    // Verify stored entry headers and body have not been mutated in store
    const afterEntry = store.get(initialEntry!.keyHash);
    expect(afterEntry).toBeDefined();
    expect(afterEntry!.body.toString('hex')).toBe(originalBodyHex);
    expect(JSON.stringify(afterEntry!.headers)).toBe(originalHeaders);
  });
});
