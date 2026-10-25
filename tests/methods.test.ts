import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  isSafe,
  isIdempotent,
  isCacheableMethod,
  isRecognizedMethod,
  validateMethod,
  ALLOWED_BY_DEFAULT,
  KNOWN_HTTP_METHODS,
} from '../src/proxy/methods.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 4: HTTP method handling (src/proxy/methods.ts)', () => {
  describe('Unit tests: RFC 9110 method flags and validation', () => {
    it('flag table unit tests: isSafe, isIdempotent, isCacheableMethod for every known method', () => {
      const expectedMatrix: Record<
        string,
        { safe: boolean; idempotent: boolean; cacheable: boolean }
      > = {
        GET: { safe: true, idempotent: true, cacheable: true },
        HEAD: { safe: true, idempotent: true, cacheable: true },
        OPTIONS: { safe: true, idempotent: true, cacheable: false },
        TRACE: { safe: true, idempotent: true, cacheable: false },
        PUT: { safe: false, idempotent: true, cacheable: false },
        DELETE: { safe: false, idempotent: true, cacheable: false },
        POST: { safe: false, idempotent: false, cacheable: false },
        PATCH: { safe: false, idempotent: false, cacheable: false },
        CONNECT: { safe: false, idempotent: false, cacheable: false },
      };

      for (const method of KNOWN_HTTP_METHODS) {
        const expected = expectedMatrix[method];
        expect(isSafe(method)).toBe(expected.safe);
        expect(isIdempotent(method)).toBe(expected.idempotent);
        expect(isCacheableMethod(method)).toBe(expected.cacheable);
        expect(isRecognizedMethod(method)).toBe(true);
      }
    });

    it('rejects unknown or case-sensitive method tokens with 501', () => {
      // FOO is unknown
      const fooRes = validateMethod('FOO');
      expect(fooRes.valid).toBe(false);
      if (!fooRes.valid) {
        expect(fooRes.status).toBe(501);
        expect(fooRes.code).toBe('NOT_IMPLEMENTED');
      }

      // lowercase "get" is unknown (case-sensitive)
      const lowerGetRes = validateMethod('get');
      expect(lowerGetRes.valid).toBe(false);
      if (!lowerGetRes.valid) {
        expect(lowerGetRes.status).toBe(501);
        expect(lowerGetRes.code).toBe('NOT_IMPLEMENTED');
      }
    });

    it('rejects recognized but disallowed methods with 405 and Allow header', () => {
      // TRACE is recognized but disallowed by default
      const traceRes = validateMethod('TRACE', ALLOWED_BY_DEFAULT);
      expect(traceRes.valid).toBe(false);
      if (!traceRes.valid && traceRes.status === 405) {
        expect(traceRes.status).toBe(405);
        expect(traceRes.code).toBe('METHOD_NOT_ALLOWED');
        expect(traceRes.allowHeader).toBe(ALLOWED_BY_DEFAULT.join(', '));
      }

      // CONNECT is recognized but disallowed by default
      const connectRes = validateMethod('CONNECT', ALLOWED_BY_DEFAULT);
      expect(connectRes.valid).toBe(false);
      if (!connectRes.valid && connectRes.status === 405) {
        expect(connectRes.status).toBe(405);
        expect(connectRes.code).toBe('METHOD_NOT_ALLOWED');
        expect(connectRes.allowHeader).toBe(ALLOWED_BY_DEFAULT.join(', '));
      }
    });

    it('allows customizing and narrowing allowedMethods via config override', () => {
      const readOnlyAllowed = ['GET', 'HEAD'];
      const postRes = validateMethod('POST', readOnlyAllowed);
      expect(postRes.valid).toBe(false);
      if (!postRes.valid && postRes.status === 405) {
        expect(postRes.status).toBe(405);
        expect(postRes.allowHeader).toBe('GET, HEAD');
      }

      const getRes = validateMethod('GET', readOnlyAllowed);
      expect(getRes.valid).toBe(true);
    });
  });

  describe('Integration tests: Proxy method routing and behavior', () => {
    let recordedRequests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    let originServer: http.Server;
    let originPort: number;
    let proxyServer: any;
    let proxyPort: number;

    beforeAll(async () => {
      // 1. Origin recording requests
      originServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          recordedRequests.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          });

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify({ ok: true })),
          });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => resolve());
      });
      originPort = (originServer.address() as net.AddressInfo).port;

      // 2. Proxy server
      proxyServer = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      proxyPort = proxyServer.httpPort!;
    });

    afterAll(async () => {
      await proxyServer.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('each allowed method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS) reaches origin with same method', async () => {
      const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

      for (const m of methods) {
        recordedRequests = [];
        const res = await rawRequest(
          proxyPort,
          `${m} /test-${m.toLowerCase()} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );

        expect(res.statusCode).toBe(200);
        expect(recordedRequests.length).toBe(1);
        expect(recordedRequests[0].method).toBe(m);
        expect(recordedRequests[0].url).toBe(`/test-${m.toLowerCase()}`);
      }
    });

    it('OPTIONS * is handled locally with 200 and Allow header; origin sees no request', async () => {
      recordedRequests = [];
      const res = await rawRequest(
        proxyPort,
        'OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['allow']).toBeDefined();
      expect(res.headers['allow']).toContain('GET');
      expect(res.headers['allow']).toContain('POST');
      expect(res.headers['allow']).toContain('OPTIONS');
      // Assert: origin was never contacted
      expect(recordedRequests.length).toBe(0);
    });

    it('OPTIONS /x is forwarded to the origin like any other request', async () => {
      recordedRequests = [];
      const res = await rawRequest(
        proxyPort,
        'OPTIONS /custom-path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(recordedRequests.length).toBe(1);
      expect(recordedRequests[0].method).toBe('OPTIONS');
      expect(recordedRequests[0].url).toBe('/custom-path');
    });

    it('denies TRACE and CONNECT by default with 405 Method Not Allowed and Allow header', async () => {
      for (const m of ['TRACE', 'CONNECT']) {
        const res = await rawRequest(
          proxyPort,
          `${m} /tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );

        expect(res.statusCode).toBe(405);
        expect(res.headers['allow']).toBeDefined();
        expect(res.headers['allow']).toContain('GET');
        const json = JSON.parse(res.body.toString());
        expect(json.error.code).toBe('METHOD_NOT_ALLOWED');
      }
    });

    it('rejects unknown method FOO with 501 Not Implemented', async () => {
      const res = await rawRequest(
        proxyPort,
        'FOO /endpoint HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(501);
      const json = JSON.parse(res.body.toString());
      expect(json.error.code).toBe('NOT_IMPLEMENTED');
    });

    it('rejects lowercase get with 501 Not Implemented (case-sensitive)', async () => {
      const res = await rawRequest(
        proxyPort,
        'get /endpoint HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(501);
      const json = JSON.parse(res.body.toString());
      expect(json.error.code).toBe('NOT_IMPLEMENTED');
    });

    it('forwards bodies on GET/HEAD/DELETE/OPTIONS as received', async () => {
      for (const m of ['GET', 'DELETE', 'OPTIONS']) {
        recordedRequests = [];
        const bodyPayload = `body-for-${m}`;

        const res = await rawRequest(
          proxyPort,
          `${m} /with-body HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${bodyPayload.length}\r\nConnection: close\r\n\r\n${bodyPayload}`
        );

        expect(res.statusCode).toBe(200);
        expect(recordedRequests.length).toBe(1);
        expect(recordedRequests[0].method).toBe(m);
        expect(recordedRequests[0].body).toBe(bodyPayload);
      }
    });

    it('forwards POST with Expect: 100-continue with full body to origin', async () => {
      recordedRequests = [];
      const postBody = 'payload-after-continue';

      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'POST',
            path: '/expect-test',
            headers: {
              Expect: '100-continue',
              'Content-Length': Buffer.byteLength(postBody),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              resolve({ statusCode: res.statusCode ?? 0, body: data });
            });
          }
        );

        req.on('error', reject);

        req.on('continue', () => {
          req.write(postBody);
          req.end();
        });
      });

      expect(res.statusCode).toBe(200);
      expect(recordedRequests.length).toBe(1);
      expect(recordedRequests[0].body).toBe(postBody);
    });

    it('narrows allowedMethods via config override', async () => {
      const restrictedProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        allowedMethods: ['GET', 'HEAD'],
      });
      const restrictedPort = restrictedProxy.httpPort!;

      try {
        const postRes = await rawRequest(
          restrictedPort,
          'POST /restricted HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        );

        expect(postRes.statusCode).toBe(405);
        expect(postRes.headers['allow']).toBe('GET, HEAD');
        const json = JSON.parse(postRes.body.toString());
        expect(json.error.code).toBe('METHOD_NOT_ALLOWED');

        const getRes = await rawRequest(
          restrictedPort,
          'GET /restricted HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        expect(getRes.statusCode).toBe(200);
      } finally {
        await restrictedProxy.stop();
      }
    });
  });
});
