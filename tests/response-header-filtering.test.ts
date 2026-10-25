import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { checkResponseStorableFromHeaders } from '../src/cache/policy.js';
import { prepareResponseHeaders } from '../src/proxy/response.js';
import type { ProxyListener } from '../src/proxy/listener.js';

describe('Feature 150: Response header filtering', () => {
  let originServer: http.Server;
  let originPort: number;
  let proxy: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;

  let originHeadersToSend: Record<string, string | string[]> = {};

  beforeEach(async () => {
    originHeadersToSend = {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=60',
    };

    originServer = http.createServer((_req, res) => {
      res.writeHead(200, originHeadersToSend);
      res.end('origin-body');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = (originServer.address() as any).port;
    store = new MemoryStore({ maxObjectBytes: 5 * 1024 * 1024 });
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('strips hop-by-hop headers and custom tokens named in response Connection header', async () => {
    originHeadersToSend = {
      'Content-Type': 'text/plain',
      'Connection': 'close, X-Upstream-Custom, X-Extra-Hop',
      'Keep-Alive': 'timeout=10, max=100',
      'Proxy-Authenticate': 'Basic realm="internal"',
      'Upgrade': 'websocket',
      'X-Upstream-Custom': 'secret-token',
      'X-Extra-Hop': 'hop-value',
      'X-Standard-Header': 'keep-me',
    };

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/hop-test`);
    expect(res.status).toBe(200);

    expect(res.headers.get('x-standard-header')).toBe('keep-me');
    expect(res.headers.get('x-upstream-custom')).toBeNull();
    expect(res.headers.get('x-extra-hop')).toBeNull();
    expect(res.headers.get('proxy-authenticate')).toBeNull();
    expect(res.headers.get('upgrade')).toBeNull();
  });

  it('strips internal headers (debug, tenant, origin identity) so they never leak downstream', async () => {
    originHeadersToSend = {
      'Content-Type': 'text/plain',
      'X-Tenant-Id': 'tenant-backend-42',
      'X-Origin-Id': 'cluster-node-9',
      'X-Origin-Url': 'http://internal.origin.local',
      'X-Internal-Secret': 'db-credential',
      'X-Debug-Trace': 'stacktrace-info',
      'X-Proxy-Debug': 'true',
      'X-Powered-By': 'PHP/8.1',
      'X-Public-Metadata': 'public-value',
    };

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/internal-leak-test`);
    expect(res.status).toBe(200);

    // Public header is forwarded
    expect(res.headers.get('x-public-metadata')).toBe('public-value');

    // All internal and debug headers must be stripped
    expect(res.headers.get('x-tenant-id')).toBeNull();
    expect(res.headers.get('x-origin-id')).toBeNull();
    expect(res.headers.get('x-origin-url')).toBeNull();
    expect(res.headers.get('x-internal-secret')).toBeNull();
    expect(res.headers.get('x-debug-trace')).toBeNull();
    expect(res.headers.get('x-proxy-debug')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('enforces Server and Via policy on forwarded responses', async () => {
    originHeadersToSend = {
      'Content-Type': 'text/plain',
      'Via': '1.0 origin-cache',
    };

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/server-via-test`);
    expect(res.status).toBe(200);

    // Via header must append proxy hop
    expect(res.headers.get('via')).toBe('1.0 origin-cache, 1.1 cdn-proxy');

    // Server header must be cdn-proxy
    expect(res.headers.get('server')).toBe('cdn-proxy');
  });

  it('enforces Set-Cookie policy: responses with Set-Cookie are not stored unless configured', async () => {
    // 1. By default, response with Set-Cookie is NOT storable
    const defaultCheck = checkResponseStorableFromHeaders({
      statusCode: 200,
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'public, max-age=3600',
        'date': new Date().toUTCString(),
        'set-cookie': 'session_id=secret123; HttpOnly; Secure',
      },
      requestTimeMs: Date.now() - 10,
      responseTimeMs: Date.now(),
    });

    expect(defaultCheck.storable).toBe(false);
    expect(defaultCheck.reason).toBe('has_set_cookie');

    // 2. When allowSetCookie is configured true, response is storable
    const allowedCheck = checkResponseStorableFromHeaders({
      statusCode: 200,
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'public, max-age=3600',
        'date': new Date().toUTCString(),
        'set-cookie': 'tracking_id=anon456',
      },
      requestTimeMs: Date.now() - 10,
      responseTimeMs: Date.now(),
      config: { allowSetCookie: true } as any,
    });

    expect(allowedCheck.storable).toBe(true);
  });
});
