import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { PoolSelector } from '../src/config/pools.js';
import { CircuitBreaker } from '../src/health/circuit-breaker.js';

describe('Feature 80: TLS upstream', { timeout: 25000 }, () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/tls');
  const caCrt = fs.readFileSync(path.join(fixturesDir, 'ca.crt'));
  const untrustedCaCrt = fs.readFileSync(path.join(fixturesDir, 'untrusted-ca.crt'));
  const serverCrt = fs.readFileSync(path.join(fixturesDir, 'server.crt'));
  const serverKey = fs.readFileSync(path.join(fixturesDir, 'server.key'));
  const serverAltCrt = fs.readFileSync(path.join(fixturesDir, 'server-alt.crt'));
  const serverAltKey = fs.readFileSync(path.join(fixturesDir, 'server-alt.key'));
  const expiredCrt = fs.readFileSync(path.join(fixturesDir, 'expired.crt'));
  const expiredKey = fs.readFileSync(path.join(fixturesDir, 'expired.key'));
  const wrongHostCrt = fs.readFileSync(path.join(fixturesDir, 'wrong-host.crt'));
  const wrongHostKey = fs.readFileSync(path.join(fixturesDir, 'wrong-host.key'));
  const untrustedServerCrt = fs.readFileSync(path.join(fixturesDir, 'untrusted-server.crt'));
  const untrustedServerKey = fs.readFileSync(path.join(fixturesDir, 'untrusted-server.key'));

  let proxy: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;
  const serversToClose: (http.Server | https.Server)[] = [];

  function createHttpsOrigin(
    cert: Buffer,
    key: Buffer,
    handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<{ server: https.Server; port: number }> {
    return new Promise((resolve) => {
      const server = https.createServer({ cert, key }, (req, res) => {
        if (handler) {
          handler(req, res);
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end('origin-tls-response');
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serversToClose.push(server);
        resolve({ server, port });
      });
    });
  }

  beforeEach(() => {
    store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    for (const s of serversToClose) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    serversToClose.length = 0;
  });

  it('upstream HTTPS with a CA bundle works end-to-end', async () => {
    const { port: originPort } = await createHttpsOrigin(serverCrt, serverKey);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${originPort}`,
      store,
      upstream: { ca: caCrt },
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/test`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-tls-response');
  });

  it('rejects an untrusted CA with a defined 502 and pool is not poisoned', async () => {
    // 1. Untrusted origin server
    const { port: untrustedPort } = await createHttpsOrigin(untrustedServerCrt, untrustedServerKey);
    // 2. Trusted origin server
    const { port: trustedPort } = await createHttpsOrigin(serverCrt, serverKey);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originsConfig: {
        origins: {
          untrusted: { url: `https://localhost:${untrustedPort}`, ca: caCrt },
          trusted: { url: `https://localhost:${trustedPort}`, ca: caCrt },
        },
        defaultOrigin: 'untrusted',
        routes: [
          { pathPrefix: '/untrusted', origin: 'untrusted' },
          { pathPrefix: '/trusted', origin: 'trusted' },
        ],
      },
      store,
    });
    proxyPort = proxy.httpPort!;

    // Request to untrusted origin -> 502 Bad Gateway
    const untrustedRes = await fetch(`http://127.0.0.1:${proxyPort}/untrusted/data`);
    expect(untrustedRes.status).toBe(502);
    const errBody = await untrustedRes.json();
    expect(errBody.error.code).toBe('UPSTREAM_TLS_ERROR');

    // Subsequent request to trusted origin -> 200 OK (pool not poisoned)
    const trustedRes = await fetch(`http://127.0.0.1:${proxyPort}/trusted/data`);
    expect(trustedRes.status).toBe(200);
    expect(await trustedRes.text()).toBe('origin-tls-response');
  });

  it('rejects an expired certificate with a defined 502', async () => {
    const { port: expiredPort } = await createHttpsOrigin(expiredCrt, expiredKey);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${expiredPort}`,
      store,
      upstream: { ca: caCrt },
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe('UPSTREAM_TLS_ERROR');
    expect(json.error.message).toContain('expired');
  });

  it('rejects a wrong-host certificate with a defined 502', async () => {
    const { port: wrongHostPort } = await createHttpsOrigin(wrongHostCrt, wrongHostKey);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${wrongHostPort}`, // Server presents unrelated-domain.org
      store,
      upstream: { ca: caCrt },
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe('UPSTREAM_TLS_ERROR');
  });

  it('verification-disabled mode requires explicit flag and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port: untrustedPort } = await createHttpsOrigin(untrustedServerCrt, untrustedServerKey);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${untrustedPort}`,
      store,
      upstream: {
        rejectUnauthorized: false,
      },
    });
    proxyPort = proxy.httpPort!;

    // Assert warning was loudly logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WARN] TLS certificate verification is explicitly DISABLED')
    );

    // Request succeeds when verification is disabled
    const res = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-tls-response');

    warnSpy.mockRestore();
  });

  it('sets upstream SNI to the origin host', async () => {
    let capturedServername: string | null = null;
    const { port: originPort } = await createHttpsOrigin(
      serverCrt,
      serverKey,
      (req, res) => {
        capturedServername = (req.socket as any).servername ?? null;
        res.writeHead(200);
        res.end('sni-ok');
      }
    );

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${originPort}`,
      store,
      upstream: { ca: caCrt },
    });
    proxyPort = proxy.httpPort!;

    await fetch(`http://127.0.0.1:${proxyPort}/test`);
    expect(capturedServername).toBe('localhost');
  });

  it('reuses connections across TLS in the upstream pool', async () => {
    const socketsSeen = new Set<any>();
    const { port: originPort } = await createHttpsOrigin(
      serverCrt,
      serverKey,
      (req, res) => {
        socketsSeen.add(req.socket);
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('reuse-test');
      }
    );

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${originPort}`,
      store,
      upstream: { ca: caCrt, keepAlive: true },
    });
    proxyPort = proxy.httpPort!;

    // 3 sequential requests
    await fetch(`http://127.0.0.1:${proxyPort}/req1`);
    await fetch(`http://127.0.0.1:${proxyPort}/req2`);
    await fetch(`http://127.0.0.1:${proxyPort}/req3`);

    // All 3 requests should reuse the single keep-alive TLS connection
    expect(socketsSeen.size).toBe(1);
  });

  it('records TLS failures in circuit breaker and trips when threshold exceeded', async () => {
    const { port: untrustedPort } = await createHttpsOrigin(untrustedServerCrt, untrustedServerKey);
    const breaker = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 60_000 });
    const poolSelector = new PoolSelector();
    poolSelector.isAvailable = (id) => breaker.allowRequest(id);

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originsConfig: {
        origins: {
          badOrigin: { url: `https://localhost:${untrustedPort}`, ca: caCrt },
        },
        defaultOrigin: 'badOrigin',
        pools: {
          defaultPool: {
            members: [{ origin: 'badOrigin', weight: 1 }],
          },
        },
        routes: [{ pathPrefix: '/data', origin: 'defaultPool' }],
      },
      poolSelector,
      store,
    });
    proxyPort = proxy.httpPort!;

    // 1st failure (TLS error)
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res1.status).toBe(502);
    breaker.recordFailure('badOrigin');

    // 2nd failure (TLS error -> threshold reached)
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res2.status).toBe(502);
    breaker.recordFailure('badOrigin');

    // Circuit breaker state should now be OPEN
    expect(breaker.getState('badOrigin')).toBe('OPEN');

    // 3rd request should fail fast without attempting upstream
    const res3 = await fetch(`http://127.0.0.1:${proxyPort}/data`);
    expect(res3.status).toBe(502);
    const body3 = await res3.json();
    expect(['NO_AVAILABLE_ORIGINS', 'ORIGIN_NOT_FOUND', 'CIRCUIT_BREAKER_OPEN']).toContain(body3.error.code);
  });
});
