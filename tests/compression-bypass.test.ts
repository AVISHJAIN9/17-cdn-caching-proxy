import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  checkCompressionBypass,
  CompressionBypassReason,
} from '../src/compression/bypass.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 71: Compression bypass', () => {
  describe('Unit: checkCompressionBypass Rule Evaluation', () => {
    it('bypasses when body size is strictly below minimum threshold', () => {
      const res = checkCompressionBypass({
        bodyLength: 1023,
        minBytes: 1024,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(res.shouldBypass).toBe(true);
      expect(res.reason).toBe('below_min_size');
    });

    it('does NOT bypass when body size is exactly at minimum threshold', () => {
      const res = checkCompressionBypass({
        bodyLength: 1024,
        minBytes: 1024,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(res.shouldBypass).toBe(false);
      expect(res.reason).toBeUndefined();
    });

    it('bypasses when Cache-Control contains no-transform in response or request', () => {
      const resResp = checkCompressionBypass({
        bodyLength: 5000,
        responseHeaders: {
          'content-type': 'text/plain',
          'cache-control': 'public, no-transform',
        },
      });
      expect(resResp.shouldBypass).toBe(true);
      expect(resResp.reason).toBe('no_transform');

      const resReq = checkCompressionBypass({
        bodyLength: 5000,
        requestHeaders: { 'cache-control': 'no-transform' },
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(resReq.shouldBypass).toBe(true);
      expect(resReq.reason).toBe('no_transform');
    });

    it('bypasses when response already has Content-Encoding', () => {
      const res = checkCompressionBypass({
        bodyLength: 5000,
        responseHeaders: {
          'content-type': 'text/plain',
          'content-encoding': 'gzip',
        },
      });
      expect(res.shouldBypass).toBe(true);
      expect(res.reason).toBe('already_encoded');
    });

    it('bypasses when content-type is non-compressible', () => {
      const res = checkCompressionBypass({
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'image/png' },
      });
      expect(res.shouldBypass).toBe(true);
      expect(res.reason).toBe('non_compressible_type');
    });

    it('bypasses on Range requests or HTTP 206 Partial Content', () => {
      const res206 = checkCompressionBypass({
        statusCode: 206,
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(res206.shouldBypass).toBe(true);
      expect(res206.reason).toBe('range_request');

      const resRange = checkCompressionBypass({
        requestHeaders: { range: 'bytes=0-100' },
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(resRange.shouldBypass).toBe(true);
      expect(resRange.reason).toBe('range_request');
    });

    it('bypasses on HTTP 204 No Content and HTTP 304 Not Modified', () => {
      const res204 = checkCompressionBypass({ statusCode: 204 });
      expect(res204.shouldBypass).toBe(true);
      expect(res204.reason).toBe('status_no_body');

      const res304 = checkCompressionBypass({ statusCode: 304 });
      expect(res304.shouldBypass).toBe(true);
      expect(res304.reason).toBe('status_no_body');
    });

    it('bypasses on HEAD request', () => {
      const res = checkCompressionBypass({
        method: 'HEAD',
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(res.shouldBypass).toBe(true);
      expect(res.reason).toBe('head_method');
    });

    it('bypasses when configured bypass header or route is present', () => {
      const resHdr = checkCompressionBypass({
        requestHeaders: { 'x-no-compression': '1' },
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'text/plain' },
      });
      expect(resHdr.shouldBypass).toBe(true);
      expect(resHdr.reason).toBe('configured_bypass');

      const resRoute = checkCompressionBypass({
        url: '/raw/export',
        bodyLength: 5000,
        responseHeaders: { 'content-type': 'text/plain' },
        bypassConfig: { routes: ['/raw/'] },
      });
      expect(resRoute.shouldBypass).toBe(true);
      expect(resRoute.reason).toBe('configured_bypass');
    });
  });

  describe('End-to-End Proxy Compression Bypass Tests', () => {
    let originServer: http.Server;
    let originPort: number;
    let proxy: any;

    afterEach(async () => {
      if (proxy) await proxy.stop();
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });

    it('bypasses below minimum size (1023 B) and exposes debug header', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '1023',
          'Cache-Control': 'max-age=60',
        });
        res.end('A'.repeat(1023));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        compression: { minBytes: 1024 },
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/small', { 'Accept-Encoding': 'gzip' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['x-compression-bypass']).toBe('below_min_size');
      expect(res.body.length).toBe(1023);
    });

    it('compresses exactly at threshold (1024 B)', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': '1024',
          'Cache-Control': 'max-age=60',
        });
        res.end('B'.repeat(1024));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        compression: { minBytes: 1024 },
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/exact', { 'Accept-Encoding': 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['x-compression-bypass']).toBeUndefined();
    });

    it('bypasses on Cache-Control: no-transform', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-transform, max-age=60',
        });
        res.end('C'.repeat(2000));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/notransform', { 'Accept-Encoding': 'gzip' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['x-compression-bypass']).toBe('no_transform');
    });

    it('passes already-encoded origin response through unchanged', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'max-age=60',
        });
        res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/already-gzip', { 'Accept-Encoding': 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.body.length).toBe(8);
    });

    it('bypasses on HTTP 204 No Content', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(204);
        res.end();
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/nocontent', { 'Accept-Encoding': 'gzip' });
      expect(res.statusCode).toBe(204);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.length).toBe(0);
    });

    it('bypasses on HEAD request while headers match GET', async () => {
      originServer = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=60',
        });
        if (req.method !== 'HEAD') {
          res.end('D'.repeat(2000));
        } else {
          res.end();
        }
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      const resHead = await makeRawRequest(proxyPort, 'HEAD', '/item', { 'Accept-Encoding': 'gzip' });
      expect(resHead.statusCode).toBe(200);
      expect(resHead.body.length).toBe(0); // Never transmits body on HEAD
      expect(resHead.headers['content-type']).toBe('text/plain');
    });

    it('passes Range or 206 Partial Content through untouched', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(206, {
          'Content-Type': 'text/plain',
          'Content-Range': 'bytes 0-99/1000',
          'Cache-Control': 'max-age=60',
        });
        res.end('E'.repeat(100));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawRequest(proxyPort, 'GET', '/part', {
        'Accept-Encoding': 'gzip',
        Range: 'bytes=0-99',
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['x-compression-bypass']).toBe('range_request');
      expect(res.body.length).toBe(100);
    });

    it('bypasses on configured bypass header or route', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=60',
        });
        res.end('F'.repeat(2000));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        compression: {
          bypass: {
            header: 'X-Custom-Skip-Compression',
            routes: ['/raw-bypass/'],
          },
        },
      });
      const proxyPort = proxy.httpPort!;

      // 1. Bypass via custom header
      const resHeader = await makeRawRequest(proxyPort, 'GET', '/normal', {
        'Accept-Encoding': 'gzip',
        'X-Custom-Skip-Compression': 'true',
      });
      expect(resHeader.headers['content-encoding']).toBeUndefined();
      expect(resHeader.headers['x-compression-bypass']).toBe('configured_bypass');

      // 2. Bypass via route prefix
      const resRoute = await makeRawRequest(proxyPort, 'GET', '/raw-bypass/file.txt', {
        'Accept-Encoding': 'gzip',
      });
      expect(resRoute.headers['content-encoding']).toBeUndefined();
      expect(resRoute.headers['x-compression-bypass']).toBe('configured_bypass');
    });
  });
});

function makeRawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
