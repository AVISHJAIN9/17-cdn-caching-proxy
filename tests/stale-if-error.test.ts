import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 145: Stale-if-error (RFC 5861 Section 4)', () => {
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
        upstreamHeadersMs: 600,
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

  it('1. Serves stale response with Warning 110 when origin returns 500 Internal Server Error', async () => {
    await configOrigin('sie-500', {
      cc: 'max-age=60, stale-if-error=300',
      cc304: 'max-age=60, stale-if-error=300',
    });

    // Prime cache
    const miss = await rawRequest(
      proxyPort,
      'GET /reval/sie-500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    const originalBody = miss.body.toString('utf-8');

    // Stale at 70s, origin configured to fail with 500
    clock.advance(70_000);
    await configOrigin('sie-500', { status: 500 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/sie-500 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('STALE');
    expect(res.headers['x-cache-reason']).toBe('stale_if_error');
    expect(res.headers['warning']).toContain('110');
    expect(res.body.toString('utf-8')).toBe(originalBody);
    expect(Number(res.headers['age'])).toBeGreaterThanOrEqual(70);
  });

  it('2. Serves stale response when origin returns 502, 503, or 504', async () => {
    for (const code of [502, 503, 504]) {
      const id = `sie-${code}`;
      await configOrigin(id, {
        cc: 'max-age=60, stale-if-error=300',
        cc304: 'max-age=60, stale-if-error=300',
      });

      const miss = await rawRequest(
        proxyPort,
        `GET /reval/${id} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(miss.statusCode).toBe(200);

      clock.advance(70_000);
      await configOrigin(id, { status: code });

      const res = await rawRequest(
        proxyPort,
        `GET /reval/${id} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-cache']).toBe('STALE');
      expect(res.headers['x-cache-reason']).toBe('stale_if_error');
      expect(res.headers['warning']).toContain('110');
    }
  });

  it('3. Serves stale response when origin server is completely down (connection failure)', async () => {
    await configOrigin('sie-down', {
      cc: 'max-age=60, stale-if-error=300',
      cc304: 'max-age=60, stale-if-error=300',
    });

    const miss = await rawRequest(
      proxyPort,
      'GET /reval/sie-down HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(miss.statusCode).toBe(200);
    const originalBody = miss.body.toString('utf-8');

    clock.advance(70_000);

    // Stop origin server completely
    await new Promise<void>((resolve) => originServer.close(() => resolve()));

    const res = await rawRequest(
      proxyPort,
      'GET /reval/sie-down HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('STALE');
    expect(res.headers['x-cache-reason']).toBe('stale_if_error');
    expect(res.headers['warning']).toContain('110');
    expect(res.body.toString('utf-8')).toBe(originalBody);
  });

  it('4. Beyond stale-if-error window, origin error is NOT masked and reaches client', async () => {
    await configOrigin('sie-expired', {
      cc: 'max-age=60, stale-if-error=300',
      cc304: 'max-age=60, stale-if-error=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/sie-expired HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    // 60s + 300s = 360s. Advance to 400s -> beyond SIE window
    clock.advance(400_000);
    await configOrigin('sie-expired', { status: 500 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/sie-expired HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-cache']).not.toBe('STALE');
  });

  it('5. must-revalidate and proxy-revalidate strictly forbid stale-if-error fallback', async () => {
    await configOrigin('sie-must-reval', {
      cc: 'max-age=60, must-revalidate, stale-if-error=300',
      cc304: 'max-age=60, must-revalidate, stale-if-error=300',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/sie-must-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await configOrigin('sie-must-reval', { status: 500 });

    const res = await rawRequest(
      proxyPort,
      'GET /reval/sie-must-reval HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-cache']).not.toBe('STALE');
  });

  it('6. Client request Cache-Control: stale-if-error enables stale fallback when origin CC lacks directive', async () => {
    await configOrigin('sie-client-req', {
      cc: 'max-age=60',
      cc304: 'max-age=60',
    });

    await rawRequest(
      proxyPort,
      'GET /reval/sie-client-req HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );

    clock.advance(70_000);
    await configOrigin('sie-client-req', { status: 503 });

    // Client provides stale-if-error=300 in request
    const res = await rawRequest(
      proxyPort,
      'GET /reval/sie-client-req HTTP/1.1\r\nHost: localhost\r\nCache-Control: stale-if-error=300\r\nConnection: close\r\n\r\n'
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('STALE');
    expect(res.headers['x-cache-reason']).toBe('stale_if_error');
    expect(res.headers['warning']).toContain('110');
  });
});
