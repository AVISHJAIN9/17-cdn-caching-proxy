import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  parseOriginsConfig,
  resolveOriginForRequest,
  OriginsConfig,
} from '../src/config/origins.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 54: Multiple origins', () => {
  let originAServer: http.Server;
  let originAPort: number;

  let originBServer: http.Server;
  let originBPort: number;

  let defaultOriginServer: http.Server;
  let defaultOriginPort: number;

  beforeAll(async () => {
    // Start Origin A (e.g., API service)
    originAServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-origin-id': 'origin-a',
        date: new Date().toUTCString(),
      });
      res.end(
        JSON.stringify({
          origin: 'origin-a',
          url: req.url,
          host: req.headers.host,
        })
      );
    });
    await new Promise<void>((r) => originAServer.listen(0, '127.0.0.1', () => r()));
    originAPort = (originAServer.address() as any).port;

    // Start Origin B (e.g., Static/Assets service)
    originBServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-origin-id': 'origin-b',
        date: new Date().toUTCString(),
      });
      res.end(
        JSON.stringify({
          origin: 'origin-b',
          url: req.url,
          host: req.headers.host,
        })
      );
    });
    await new Promise<void>((r) => originBServer.listen(0, '127.0.0.1', () => r()));
    originBPort = (originBServer.address() as any).port;

    // Start Default Origin
    defaultOriginServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-origin-id': 'default-origin',
        date: new Date().toUTCString(),
      });
      res.end(
        JSON.stringify({
          origin: 'default-origin',
          url: req.url,
          host: req.headers.host,
        })
      );
    });
    await new Promise<void>((r) => defaultOriginServer.listen(0, '127.0.0.1', () => r()));
    defaultOriginPort = (defaultOriginServer.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => originAServer.close(() => r()));
    await new Promise<void>((r) => originBServer.close(() => r()));
    await new Promise<void>((r) => defaultOriginServer.close(() => r()));
  });

  describe('Configuration & Route Matching Logic', () => {
    const config: OriginsConfig = parseOriginsConfig({
      origins: {
        api: { url: 'http://127.0.0.1:9001' },
        assets: { url: 'http://127.0.0.1:9002' },
        default: { url: 'http://127.0.0.1:9000' },
      },
      defaultOrigin: 'default',
      routes: [
        { pathPrefix: '/api/', origin: 'api' },
        { pathPrefix: '/assets/', origin: 'assets' },
        { host: 'api.example.com', origin: 'api' },
        { header: { name: 'x-tenant', value: 'special' }, origin: 'assets' },
        { pathPattern: '^/v[0-9]+/items', origin: 'api' },
      ],
    });

    it('matches pathPrefix rule', () => {
      const match = resolveOriginForRequest({ url: '/api/v1/users', headers: {} }, config);
      expect(match).toBe('api');
    });

    it('matches host header rule', () => {
      const match = resolveOriginForRequest(
        { url: '/status', headers: { host: 'api.example.com' } },
        config
      );
      expect(match).toBe('api');
    });

    it('matches custom header rule', () => {
      const match = resolveOriginForRequest(
        { url: '/anything', headers: { 'x-tenant': 'special' } },
        config
      );
      expect(match).toBe('assets');
    });

    it('matches pathPattern regex rule', () => {
      const match = resolveOriginForRequest({ url: '/v2/items/42', headers: {} }, config);
      expect(match).toBe('api');
    });

    it('falls back to defaultOrigin when no rule matches', () => {
      const match = resolveOriginForRequest({ url: '/unmatched', headers: {} }, config);
      expect(match).toBe('default');
    });
  });

  describe('End-to-End Multi-Origin Proxy Routing', () => {
    it('routes requests to different origins based on path prefix', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            api: { url: `http://127.0.0.1:${originAPort}` },
            assets: { url: `http://127.0.0.1:${originBPort}` },
            main: { url: `http://127.0.0.1:${defaultOriginPort}` },
          },
          defaultOrigin: 'main',
          routes: [
            { pathPrefix: '/api', origin: 'api' },
            { pathPrefix: '/assets', origin: 'assets' },
          ],
        },
      });

      try {
        // Request to /api/users -> Origin A
        const resA = await fetch(`http://127.0.0.1:${proxy.httpPort}/api/users`);
        expect(resA.status).toBe(200);
        expect(resA.headers.get('x-origin-id')).toBe('origin-a');
        const dataA: any = await resA.json();
        expect(dataA.origin).toBe('origin-a');
        expect(dataA.url).toBe('/api/users');

        // Request to /assets/logo.png -> Origin B
        const resB = await fetch(`http://127.0.0.1:${proxy.httpPort}/assets/logo.png`);
        expect(resB.status).toBe(200);
        expect(resB.headers.get('x-origin-id')).toBe('origin-b');
        const dataB: any = await resB.json();
        expect(dataB.origin).toBe('origin-b');
        expect(dataB.url).toBe('/assets/logo.png');

        // Request to /home -> Default Origin
        const resMain = await fetch(`http://127.0.0.1:${proxy.httpPort}/home`);
        expect(resMain.status).toBe(200);
        expect(resMain.headers.get('x-origin-id')).toBe('default-origin');
        const dataMain: any = await resMain.json();
        expect(dataMain.origin).toBe('default-origin');
        expect(dataMain.url).toBe('/home');
      } finally {
        await proxy.close();
      }
    });

    it('respects origin-specific hostHeader overrides', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            api: {
              url: `http://127.0.0.1:${originAPort}`,
              hostHeader: 'internal-api.service.local',
            },
            main: { url: `http://127.0.0.1:${defaultOriginPort}` },
          },
          defaultOrigin: 'main',
          routes: [{ pathPrefix: '/api', origin: 'api' }],
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/api/config`);
        expect(res.status).toBe(200);
        const data: any = await res.json();
        expect(data.origin).toBe('origin-a');
        expect(data.host).toBe('internal-api.service.local');
      } finally {
        await proxy.close();
      }
    });

    it('returns 502 with ORIGIN_NOT_FOUND if matched route points to an invalid origin ID', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            main: { url: `http://127.0.0.1:${defaultOriginPort}` },
          },
          defaultOrigin: 'main',
          routes: [{ pathPrefix: '/broken', origin: 'non-existent-origin' }],
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/broken/endpoint`);
        expect(res.status).toBe(502);
        const data: any = await res.json();
        expect(data.error.code).toBe('ORIGIN_NOT_FOUND');
      } finally {
        await proxy.close();
      }
    });
  });
});
