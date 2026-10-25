import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { prepareResponseHeaders, forwardResponseHeaders } from '../src/proxy/response.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { parseRequest } from '../src/proxy/request.js';

describe('Feature 1: Response forwarding (src/proxy/response.ts)', () => {
  it('removes standard hop-by-hop headers and custom Connection-named headers', () => {
    const originHeaders: http.IncomingHttpHeaders = {
      'content-type': 'application/json',
      connection: 'close, X-Foo, X-Bar',
      'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic',
      'proxy-authorization': 'Basic credentials',
      te: 'trailers',
      trailer: 'X-Checksum',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'proxy-connection': 'keep-alive',
      'x-foo': 'secret-1',
      'x-bar': 'secret-2',
      'x-keep': 'important-data',
    };

    const res = prepareResponseHeaders(200, 'OK', originHeaders, 'GET');

    expect(res.headers).not.toHaveProperty('connection');
    expect(res.headers).not.toHaveProperty('keep-alive');
    expect(res.headers).not.toHaveProperty('proxy-authenticate');
    expect(res.headers).not.toHaveProperty('proxy-authorization');
    expect(res.headers).not.toHaveProperty('te');
    expect(res.headers).not.toHaveProperty('trailer');
    expect(res.headers).not.toHaveProperty('transfer-encoding');
    expect(res.headers).not.toHaveProperty('upgrade');
    expect(res.headers).not.toHaveProperty('proxy-connection');
    expect(res.headers).not.toHaveProperty('x-foo');
    expect(res.headers).not.toHaveProperty('x-bar');

    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-keep']).toBe('important-data');
  });

  it('preserves multiple Set-Cookie headers separately (never joined)', () => {
    const originHeaders: http.IncomingHttpHeaders = {
      'set-cookie': [
        'id=a3fWa; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly',
        'session=e852ff; SameSite=Strict',
      ],
    };

    const res = prepareResponseHeaders(200, 'OK', originHeaders, 'GET');
    expect(res.headers['set-cookie']).toEqual([
      'id=a3fWa; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly',
      'session=e852ff; SameSite=Strict',
    ]);
  });

  it('appends proxy hop to existing Via header', () => {
    const originHeadersWithVia: http.IncomingHttpHeaders = {
      via: '1.0 origin-cache-edge',
    };

    const res = prepareResponseHeaders(200, 'OK', originHeadersWithVia, 'GET');
    expect(res.headers['via']).toBe('1.0 origin-cache-edge, 1.1 cdn-proxy');

    const originHeadersNoVia: http.IncomingHttpHeaders = {};
    const resNoVia = prepareResponseHeaders(200, 'OK', originHeadersNoVia, 'GET');
    expect(resNoVia.headers['via']).toBe('1.1 cdn-proxy');
  });

  it('passes 302 and Location header through without following', () => {
    const originHeaders: http.IncomingHttpHeaders = {
      location: 'https://cdn.example.com/login?redirect=%2Faccount',
    };

    const res = prepareResponseHeaders(302, 'Found', originHeaders, 'GET');
    expect(res.statusCode).toBe(302);
    expect(res.statusMessage).toBe('Found');
    expect(res.headers['location']).toBe('https://cdn.example.com/login?redirect=%2Faccount');
  });

  it('handles bodyless responses: HEAD keeps Content-Length; 204/304 strip Content-Length', () => {
    // HEAD request
    const headRes = prepareResponseHeaders(
      200,
      'OK',
      { 'content-type': 'text/html', 'content-length': '1024' },
      'HEAD'
    );
    expect(headRes.isBodyless).toBe(true);
    expect(headRes.headers['content-length']).toBe('1024');

    // 204 No Content
    const res204 = prepareResponseHeaders(
      204,
      'No Content',
      { 'content-length': '0', 'x-custom': 'abc' },
      'POST'
    );
    expect(res204.isBodyless).toBe(true);
    expect(res204.headers).not.toHaveProperty('content-length');
    expect(res204.headers['x-custom']).toBe('abc');

    // 304 Not Modified
    const res304 = prepareResponseHeaders(
      304,
      'Not Modified',
      { etag: '"v1.0"', 'content-length': '512' },
      'GET'
    );
    expect(res304.isBodyless).toBe(true);
    expect(res304.headers).not.toHaveProperty('content-length');
    expect(res304.headers['etag']).toBe('"v1.0"');
  });

  describe('Integration with real server (forwardResponseHeaders)', () => {
    let origin: http.Server;
    let originPort: number;
    let proxy: ProxyListener;
    let proxyPort: number;

    beforeAll(async () => {
      origin = http.createServer((req, res) => {
        if (req.url === '/test-head') {
          res.writeHead(200, {
            'Content-Length': '88',
            'Content-Type': 'text/plain',
            'Set-Cookie': ['c1=val1', 'c2=val2'],
            Connection: 'close, X-Secret',
            'X-Secret': 'hide-me',
            'X-Visible': 'show-me',
          });
          res.end();
          return;
        }

        if (req.url === '/test-204') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/test-redirect') {
          res.writeHead(302, { Location: '/destination' });
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('regular body');
      });

      await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
      originPort = (origin.address() as any).port;

      proxy = new ProxyListener(
        {
          listeners: { http: { host: '127.0.0.1', port: 0 } },
          handleSignals: false,
        },
        async (req, res) => {
          const proxyReq = await parseRequest(req, res);
          if (!proxyReq) return;

          const upstreamReq = http.request(
            {
              host: '127.0.0.1',
              port: originPort,
              method: proxyReq.method,
              path: proxyReq.url,
            },
            (originRes) => {
              const { isBodyless } = forwardResponseHeaders(
                originRes,
                res,
                proxyReq.method,
                proxyReq.id
              );
              if (!isBodyless) {
                originRes.pipe(res);
              }
            }
          );
          proxyReq.body.pipe(upstreamReq);
        }
      );

      await proxy.start();
      proxyPort = proxy.httpPort!;
    });

    afterAll(async () => {
      await proxy.stop();
      await new Promise<void>((r) => origin.close(() => r()));
    });

    it('HEAD request returns 200, preserves content-length, has empty body, and strips connection header', async () => {
      const result = await new Promise<{
        statusCode: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'HEAD',
            path: '/test-head',
          },
          (res) => {
            let data = '';
            res.on('data', (d) => (data += d));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: data,
              })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers['content-length']).toBe('88');
      expect(result.headers['set-cookie']).toEqual(['c1=val1', 'c2=val2']);
      expect(result.headers['x-visible']).toBe('show-me');
      expect(result.headers).not.toHaveProperty('x-secret');
      expect(result.headers['via']).toBe('1.1 cdn-proxy');
      expect(result.body).toBe('');
    });

    it('302 redirect passes through location header without following', async () => {
      const result = await new Promise<{
        statusCode: number;
        location?: string;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: '/test-redirect',
          },
          (res) => {
            resolve({
              statusCode: res.statusCode ?? 0,
              location: res.headers.location,
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(result.statusCode).toBe(302);
      expect(result.location).toBe('/destination');
    });

    it('204 response returns no body', async () => {
      const result = await new Promise<{
        statusCode: number;
        body: string;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'POST',
            path: '/test-204',
          },
          (res) => {
            let data = '';
            res.on('data', (d) => (data += d));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                body: data,
              })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
    });
  });
});
