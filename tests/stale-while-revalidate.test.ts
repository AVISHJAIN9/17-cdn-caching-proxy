import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { originServer, resetStats, getRevalState } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 26: Stale-while-revalidate (RFC 5861)', () => {
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
      }).on('error', reject);
    });
  }

  async function resetOrigin(): Promise<void> {
    await rawRequest(
      originPort,
      'POST /__reset HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
  }

  async function configOrigin(id: string, patch: Record<string, any>): Promise<void> {
    const body = JSON.stringify(patch);
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

  it('1. Serves stale response immediately and asynchronously refreshes entry in background', async () => {
    await configOrigin('swr-item1', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });

    // Initial fetch -> MISS
    const miss = await rawRequest(
      proxyPort,
      'GET /reval/swr-item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    expect(miss.headers['x-cache']).toBe('MISS');
    const initialBody = miss.body.toString('utf-8');

    // Advance clock past max-age (60s) into SWR window (70s)
    clock.advance(70_000);
    await resetOrigin();

    // Second fetch -> Serves STALE immediately
    const staleRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(staleRes.statusCode).toBe(200);
    expect(staleRes.headers['x-cache']).toBe('STALE');
    expect(staleRes.headers['x-cache-reason']).toBe('stale_while_revalidate');
    expect(staleRes.body.toString('utf-8')).toBe(initialBody);
    expect(Number(staleRes.headers['age'])).toBeGreaterThanOrEqual(70);
    expect(staleRes.headers['warning']).toBeUndefined();

    // Wait for background revalidation to complete
    await new Promise((r) => setTimeout(r, 100));

    const logs = await getOriginLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].path).toBe('/reval/swr-item1');
    expect(logs[0].ifNoneMatch).toBe('"swr-item1-v1"');

    // Next fetch is a fresh HIT
    await resetOrigin();
    const hitRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(hitRes.statusCode).toBe(200);
    expect(hitRes.headers['x-cache']).toBe('HIT');
  });

  it('2. Origin 200 during background revalidation updates cache with new body', async () => {
    await configOrigin('swr-item2', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });

    const miss = await rawRequest(
      proxyPort,
      'GET /reval/swr-item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    const bodyV1 = miss.body.toString('utf-8');

    // Stale at 70s, bump origin version to v2
    clock.advance(70_000);
    await bumpOrigin('swr-item2');

    // Stale request receives v1
    const staleRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    expect(staleRes.statusCode).toBe(200);
    expect(staleRes.headers['x-cache']).toBe('STALE');
    expect(staleRes.body.toString('utf-8')).toBe(bodyV1);

    // Wait for background revalidation
    await new Promise((r) => setTimeout(r, 100));

    // Next request receives v2 as HIT
    const hitRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-item2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(hitRes.statusCode).toBe(200);
    expect(hitRes.headers['x-cache']).toBe('HIT');
    expect(hitRes.body.toString('utf-8')).not.toBe(bodyV1);
  });

  it('3. must-revalidate overrides stale-while-revalidate (never served stale)', async () => {
    await configOrigin('swr-must-reval', {
      cc: 'max-age=60, must-revalidate, stale-while-revalidate=300',
      cc304: 'max-age=60, must-revalidate, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-must-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    // Must revalidate synchronously; header is REVALIDATED, not STALE
    const res = await rawRequest(
      proxyPort,
      'GET /reval/swr-must-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  it('4. proxy-revalidate overrides stale-while-revalidate', async () => {
    await configOrigin('swr-proxy-reval', {
      cc: 'max-age=60, proxy-revalidate, stale-while-revalidate=300',
      cc304: 'max-age=60, proxy-revalidate, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-proxy-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/swr-proxy-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  it('5. s-maxage overrides stale-while-revalidate on shared cache', async () => {
    await configOrigin('swr-s-maxage', {
      cc: 's-maxage=60, stale-while-revalidate=300',
      cc304: 's-maxage=60, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-s-maxage HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/swr-s-maxage HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  it('6. Beyond stale-while-revalidate window, entry is not served stale', async () => {
    await configOrigin('swr-expired', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-expired HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // 60s + 300s = 360s. Advance to 400s -> beyond SWR window
    clock.advance(400_000);
    await resetOrigin();

    const res = await rawRequest(
      proxyPort,
      'GET /reval/swr-expired HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('REVALIDATED');
  });

  it('7. Concurrency: N parallel requests serve stale while exactly 1 background revalidation runs', async () => {
    await configOrigin('swr-parallel', {
      cc: 'max-age=60, stale-while-revalidate=300',
      cc304: 'max-age=60, stale-while-revalidate=300',
    });

    const prime = await rawRequest(
      proxyPort,
      'GET /reval/swr-parallel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(prime.statusCode).toBe(200);

    // Now set delay for revalidation
    await configOrigin('swr-parallel', {
      delayMs: 200,
    });

    const logsBefore = await getOriginLogs();

    clock.advance(70_000);


    // Fire 10 parallel requests for the stale entry
    const parallelCount = 10;
    const promises = Array.from({ length: parallelCount }, () =>
      rawRequest(
        proxyPort,
        'GET /reval/swr-parallel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      )
    );

    const results = await Promise.all(promises);

    // All 10 requests should receive 200 STALE
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('STALE');
      expect(res.headers['x-cache-reason']).toBe('stale_while_revalidate');
    }

    // Wait for the single background revalidation to complete
    await new Promise((r) => setTimeout(r, 300));

    const logsAfter = await getOriginLogs();
    // Exactly 1 background request was sent to origin
    expect(logsAfter.length - logsBefore.length).toBe(1);
  });
  it('8. Origin failure in background revalidation does not impact client who received stale', async () => {
    await configOrigin('swr-fail', {
      cc: 'max-age=60, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-fail HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    // Origin fails on subsequent requests
    await configOrigin('swr-fail', { status: 500 });
    await resetOrigin();

    const staleRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-fail HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(staleRes.statusCode).toBe(200);
    expect(staleRes.headers['x-cache']).toBe('STALE');

    // Wait for background failure to be handled cleanly
    await new Promise((r) => setTimeout(r, 100));
    // Verify proxy is still healthy
    const statsRes = await rawRequest(
      proxyPort,
      'GET /__cache/stats HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(statsRes.statusCode).toBe(200);
  });

  it('9. Client Cache-Control: no-cache bypasses stale-while-revalidate', async () => {
    await configOrigin('swr-nocache', {
      cc: 'max-age=60, stale-while-revalidate=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/swr-nocache HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);

    const bypassRes = await rawRequest(
      proxyPort,
      'GET /reval/swr-nocache HTTP/1.1\r\nHost: localhost\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n'
    );
    expect(bypassRes.statusCode).toBe(200);
    expect(bypassRes.headers['x-cache']).toBe('BYPASS');
    expect(bypassRes.headers['x-cache-reason']).toBe('client_no_cache');
  });
});
