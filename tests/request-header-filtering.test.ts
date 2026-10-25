import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { normalizeHeadersForForwarding } from '../src/proxy/headers.js';
import type { ProxyListener } from '../src/proxy/listener.js';

describe('Feature 91: Request header filtering', () => {
  let originServer: http.Server;
  let originPort: number;
  let receivedHeaders: http.IncomingHttpHeaders = {};
  let proxy: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;

  beforeEach(async () => {
    receivedHeaders = {};
    originServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('origin-response');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = (originServer.address() as any).port;
    store = new MemoryStore({ maxObjectBytes: 10 * 1024 * 1024 });
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('strips hop-by-hop headers and custom headers named in Connection header', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const rawRequest =
      `GET /hop-test HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${proxyPort}\r\n` +
      `Connection: close, X-Custom-Hop, X-Another-Hop\r\n` +
      `Keep-Alive: timeout=5\r\n` +
      `Upgrade: websocket\r\n` +
      `Proxy-Connection: close\r\n` +
      `X-Custom-Hop: sensitive-token\r\n` +
      `X-Another-Hop: internal-secret\r\n` +
      `X-Standard-Header: keep-this\r\n` +
      `\r\n`;

    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.write(rawRequest);

    const data = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c) => (buf += c.toString('utf-8')));
      socket.on('end', () => resolve(buf));
    });

    expect(data).toContain('HTTP/1.1 200 OK');
    expect(receivedHeaders['x-standard-header']).toBe('keep-this');
    expect(receivedHeaders['x-custom-hop']).toBeUndefined();
    expect(receivedHeaders['x-another-hop']).toBeUndefined();
    expect(receivedHeaders['upgrade']).toBeUndefined();
    expect(receivedHeaders['proxy-connection']).toBeUndefined();
  });

  it('removes client-supplied internal headers when proxy peer is untrusted', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      trustForwardedHeaders: false,
    });
    proxyPort = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${proxyPort}/untrusted-internal`, {
      headers: {
        'X-Forwarded-For': '198.51.100.1, 198.51.100.2',
        'X-Forwarded-Proto': 'https',
        'X-Tenant-Id': 'attacker-tenant',
        'X-Client-Cert-Fingerprint': 'spoofed-fp',
        'X-Internal-Role': 'superadmin',
        'X-Proxy-Debug': 'true',
        'X-Legit-Header': 'hello',
      },
    });

    expect(res.status).toBe(200);
    expect(receivedHeaders['x-legit-header']).toBe('hello');
    // Spoofed internal headers must be stripped
    expect(receivedHeaders['x-tenant-id']).toBeUndefined();
    expect(receivedHeaders['x-client-cert-fingerprint']).toBeUndefined();
    expect(receivedHeaders['x-internal-role']).toBeUndefined();
    expect(receivedHeaders['x-proxy-debug']).toBeUndefined();
    // X-Forwarded-For contains ONLY actual client IP, not spoofed chain
    expect(receivedHeaders['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('allows proxy-injected verified internal headers to reach upstream', async () => {
    const forwarded = normalizeHeadersForForwarding(
      {
        'x-tenant-id': 'untrusted-client-value',
        'x-foo': 'bar',
      },
      {
        clientIp: '127.0.0.1',
        trustForwardedHeaders: false,
        internalHeaders: {
          'x-tenant-id': 'verified-tenant-42',
          'x-verified-identity': 'user-123',
        },
      }
    );

    expect(forwarded['x-foo']).toBe('bar');
    expect(forwarded['x-tenant-id']).toBe('verified-tenant-42');
    expect(forwarded['x-verified-identity']).toBe('user-123');
  });

  it('rejects duplicate sensitive headers (Authorization)', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const rawRequest =
      `GET /dup-auth HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${proxyPort}\r\n` +
      `Authorization: Bearer token1\r\n` +
      `Authorization: Bearer token2\r\n` +
      `\r\n`;

    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.write(rawRequest);

    const data = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c) => (buf += c.toString('utf-8')));
      socket.on('end', () => resolve(buf));
    });

    expect(data).toContain('HTTP/1.1 400 Bad Request');
    expect(data).toContain('DUPLICATE_HEADER');
  });

  it('rejects oversized sensitive headers', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    const hugeToken = 'A'.repeat(8500);
    const rawRequest =
      `GET /huge-auth HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${proxyPort}\r\n` +
      `Authorization: Bearer ${hugeToken}\r\n` +
      `\r\n`;

    const socket = net.connect(proxyPort, '127.0.0.1');
    socket.write(rawRequest);

    const data = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c) => (buf += c.toString('utf-8')));
      socket.on('end', () => resolve(buf));
    });

    expect(data).toContain('HTTP/1.1 431');
    expect(data).toContain('HEADERS_TOO_LARGE');
  });

  it('rejects header-injection attempts with CR or LF characters', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    // Send malformed header with embedded CR/LF
    const socket = net.connect(proxyPort, '127.0.0.1');
    const rawRequest =
      `GET /injection HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${proxyPort}\r\n` +
      `X-Evil: value\rInjected: evil\r\n` +
      `\r\n`;

    socket.write(rawRequest);

    const data = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c) => (buf += c.toString('utf-8')));
      socket.on('end', () => resolve(buf));
      socket.on('close', () => resolve(buf));
    });

    // Either 400 Bad Request with HEADER_INJECTION or HTTP parser closes invalid socket
    expect(data).toMatch(/HTTP\/1\.1 400|HPE_INVALID_HEADER_TOKEN/);
  });
});
