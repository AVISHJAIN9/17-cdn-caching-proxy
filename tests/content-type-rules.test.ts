import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  isCompressibleContentType,
  normalizeContentType,
  ContentTypeRulesConfig,
} from '../src/compression/rules.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 73: Content-type rules', () => {
  describe('Unit: Content Type Normalization and Matching', () => {
    it('normalizes media type by stripping parameters and lowercasing', () => {
      expect(normalizeContentType('text/html; charset=utf-8')).toBe('text/html');
      expect(normalizeContentType('  APPLICATION/JSON ; boundary=something ')).toBe('application/json');
      expect(normalizeContentType('IMAGE/SVG+XML')).toBe('image/svg+xml');
      expect(normalizeContentType(undefined)).toBe('');
      expect(normalizeContentType('')).toBe('');
    });

    it('identifies standard compressible MIME types', () => {
      expect(isCompressibleContentType('text/html')).toBe(true);
      expect(isCompressibleContentType('text/plain; charset=iso-8859-1')).toBe(true);
      expect(isCompressibleContentType('text/css')).toBe(true);
      expect(isCompressibleContentType('application/json')).toBe(true);
      expect(isCompressibleContentType('APPLICATION/JSON; charset=utf-8')).toBe(true);
      expect(isCompressibleContentType('application/javascript')).toBe(true);
      expect(isCompressibleContentType('application/xml')).toBe(true);
      expect(isCompressibleContentType('image/svg+xml')).toBe(true);
    });

    it('rejects already-compressed or binary media types', () => {
      expect(isCompressibleContentType('image/png')).toBe(false);
      expect(isCompressibleContentType('image/jpeg')).toBe(false);
      expect(isCompressibleContentType('video/mp4')).toBe(false);
      expect(isCompressibleContentType('application/zip')).toBe(false);
      expect(isCompressibleContentType('font/woff2')).toBe(false);
      expect(isCompressibleContentType('application/octet-stream')).toBe(false);
    });

    it('uses documented default (incompressible) for missing or invalid Content-Type', () => {
      expect(isCompressibleContentType(undefined)).toBe(false);
      expect(isCompressibleContentType('')).toBe(false);
      expect(isCompressibleContentType('   ')).toBe(false);
      expect(isCompressibleContentType('invalid-format-without-slash')).toBe(false);
    });

    it('respects configurable allow and deny overrides', () => {
      const config: ContentTypeRulesConfig = {
        allow: ['application/octet-stream', 'custom/data'],
        deny: ['text/html'],
      };

      // text/html is normally compressible, but denied by config
      expect(isCompressibleContentType('text/html', config)).toBe(false);

      // application/octet-stream is normally excluded, but allowed by config
      expect(isCompressibleContentType('application/octet-stream', config)).toBe(true);
      expect(isCompressibleContentType('custom/data; version=1', config)).toBe(true);

      // other defaults still apply if not in allow/deny
      expect(isCompressibleContentType('application/json', config)).toBe(true);
      expect(isCompressibleContentType('image/png', config)).toBe(false);
    });
  });

  describe('End-to-End Proxy Content-Type Enforcement', () => {
    let originServer: http.Server;
    let originPort: number;
    let proxy: any;

    afterEach(async () => {
      if (proxy) await proxy.stop();
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });

    it('compresses compressible content-types (text/html, application/json, image/svg+xml)', async () => {
      originServer = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (url.pathname === '/page.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=60' });
          res.end('<!DOCTYPE html><html><body><h1>' + 'Compressible HTML '.repeat(100) + '</h1></body></html>');
        } else if (url.pathname === '/data.json') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' });
          res.end(JSON.stringify({ data: 'item '.repeat(300) }));
        } else if (url.pathname === '/vector.svg') {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=60' });
          res.end('<svg viewBox="0 0 100 100">' + '<circle cx="50" cy="50" r="40"/>'.repeat(50) + '</svg>');
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

      // 1. text/html should be compressed
      const resHtml = await makeRawGet(proxyPort, '/page.html', { 'Accept-Encoding': 'gzip' });
      expect(resHtml.headers['content-encoding']).toBe('gzip');

      // 2. application/json should be compressed
      const resJson = await makeRawGet(proxyPort, '/data.json', { 'Accept-Encoding': 'gzip' });
      expect(resJson.headers['content-encoding']).toBe('gzip');

      // 3. image/svg+xml should be compressed
      const resSvg = await makeRawGet(proxyPort, '/vector.svg', { 'Accept-Encoding': 'gzip' });
      expect(resSvg.headers['content-encoding']).toBe('gzip');
    });

    it('does NOT compress incompressible types (image/png, video/mp4, application/zip, font/woff2)', async () => {
      originServer = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const fakeData = Buffer.alloc(2048, 0x42);
        if (url.pathname === '/img.png') {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' });
          res.end(fakeData);
        } else if (url.pathname === '/video.mp4') {
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'max-age=60' });
          res.end(fakeData);
        } else if (url.pathname === '/archive.zip') {
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'max-age=60' });
          res.end(fakeData);
        } else if (url.pathname === '/font.woff2') {
          res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=60' });
          res.end(fakeData);
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

      for (const path of ['/img.png', '/video.mp4', '/archive.zip', '/font.woff2']) {
        const res = await makeRawGet(proxyPort, path, { 'Accept-Encoding': 'gzip, br' });
        expect(res.headers['content-encoding']).toBeUndefined();
      }
    });

    it('allows content-type overrides via proxy configuration', async () => {
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/custom-archive', 'Cache-Control': 'max-age=60' });
        res.end('Compress me please '.repeat(100));
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      // Start proxy with allow override for application/custom-archive
      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        compression: {
          types: {
            allow: ['application/custom-archive'],
          },
        },
      });
      const proxyPort = proxy.httpPort!;

      const res = await makeRawGet(proxyPort, '/custom', { 'Accept-Encoding': 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
    });
  });
});

function makeRawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
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
