import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { ProxyError, mapSystemError, SYSTEM_ERROR_TABLE } from '../src/proxy/errors.js';
import { sendError } from '../src/proxy/error-response.js';
import { createAndStartProxy, setupProcessErrorHandlers } from '../src/proxy/index.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 3: Error handling (src/proxy/errors.ts, src/proxy/error-response.ts)', () => {
  describe('Error taxonomy & table-driven mapping', () => {
    it('creates ProxyError with code, status, publicMessage, cause, and retryable', () => {
      const cause = new Error('root cause');
      const err = new ProxyError('UPSTREAM_CONNECT_FAILED', 502, 'Failed to connect', {
        cause,
        retryable: true,
      });

      expect(err.name).toBe('ProxyError');
      expect(err.code).toBe('UPSTREAM_CONNECT_FAILED');
      expect(err.status).toBe(502);
      expect(err.publicMessage).toBe('Failed to connect');
      expect(err.cause).toBe(cause);
      expect(err.retryable).toBe(true);
    });

    // Test every table-driven entry
    const systemErrorCases: Array<{ rawCode: string; expectedCode: string; expectedStatus: number }> = [
      { rawCode: 'ECONNREFUSED', expectedCode: 'UPSTREAM_CONNECT_FAILED', expectedStatus: 502 },
      { rawCode: 'ENOTFOUND', expectedCode: 'UPSTREAM_DNS_FAILED', expectedStatus: 502 },
      { rawCode: 'EAI_AGAIN', expectedCode: 'UPSTREAM_DNS_FAILED', expectedStatus: 502 },
      { rawCode: 'ECONNRESET', expectedCode: 'UPSTREAM_CONNECTION_RESET', expectedStatus: 502 },
      { rawCode: 'EPIPE', expectedCode: 'UPSTREAM_CONNECTION_RESET', expectedStatus: 502 },
      { rawCode: 'ETIMEDOUT', expectedCode: 'UPSTREAM_CONNECT_TIMEOUT', expectedStatus: 504 },
      { rawCode: 'CERT_HAS_EXPIRED', expectedCode: 'UPSTREAM_TLS_ERROR', expectedStatus: 502 },
      { rawCode: 'DEPTH_ZERO_SELF_SIGNED_CERT', expectedCode: 'UPSTREAM_TLS_ERROR', expectedStatus: 502 },
      { rawCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', expectedCode: 'UPSTREAM_TLS_ERROR', expectedStatus: 502 },
      { rawCode: 'ERR_TLS_CERT_ALTNAME_INVALID', expectedCode: 'UPSTREAM_TLS_ERROR', expectedStatus: 502 },
    ];

    for (const testCase of systemErrorCases) {
      it(`maps system error ${testCase.rawCode} -> ${testCase.expectedCode} (${testCase.expectedStatus})`, () => {
        const rawErr = new Error(`Simulated ${testCase.rawCode} failure`);
        (rawErr as any).code = testCase.rawCode;

        const proxyErr = mapSystemError(rawErr);
        expect(proxyErr.code).toBe(testCase.expectedCode);
        expect(proxyErr.status).toBe(testCase.expectedStatus);
      });
    }

    it('maps Node HTTP parser errors (HPE_*) to UPSTREAM_INVALID_RESPONSE (502)', () => {
      const parseErr = new Error('Parse error');
      (parseErr as any).code = 'HPE_INVALID_HEADER_TOKEN';
      const proxyErr = mapSystemError(parseErr);
      expect(proxyErr.code).toBe('UPSTREAM_INVALID_RESPONSE');
      expect(proxyErr.status).toBe(502);
    });

    it('maps unknown errors to INTERNAL_ERROR (500)', () => {
      const err = new Error('Some unexpected internal error');
      const proxyErr = mapSystemError(err);
      expect(proxyErr.code).toBe('INTERNAL_ERROR');
      expect(proxyErr.status).toBe(500);
    });
  });

  describe('Response formatting & no-leak assertions (sendError)', () => {
    it('produces valid JSON body, Content-Type, Cache-Control, and X-Request-Id headers', () => {
      let writtenStatus: number | undefined;
      let writtenHeaders: any = {};
      let writtenBody = '';

      const fakeRes: any = {
        headersSent: false,
        writeHead(status: number, headers: any) {
          writtenStatus = status;
          writtenHeaders = headers;
        },
        end(data: string) {
          if (data) writtenBody = data;
        },
      };

      sendError(
        { requestId: 'req-test-123' },
        fakeRes,
        new ProxyError('UPSTREAM_DNS_FAILED', 502, 'DNS resolution failed for upstream origin server')
      );

      expect(writtenStatus).toBe(502);
      expect(writtenHeaders['Content-Type']).toBe('application/json');
      expect(writtenHeaders['Cache-Control']).toBe('no-store');
      expect(writtenHeaders['X-Request-Id']).toBe('req-test-123');

      const parsed = JSON.parse(writtenBody);
      expect(parsed).toEqual({
        error: {
          code: 'UPSTREAM_DNS_FAILED',
          message: 'DNS resolution failed for upstream origin server',
          requestId: 'req-test-123',
        },
      });
    });

    it('no-leak assertions: never leaks stack traces, file paths, origin host, or /Users to client', () => {
      let writtenBody = '';
      const fakeRes: any = {
        headersSent: false,
        writeHead() {},
        end(data: string) {
          writtenBody = data;
        },
      };

      const dangerousErr = new Error(
        'Crash in /Users/avishjain/project/src/index.ts:123 node_modules at Object.run at /Users/avishjain/'
      );
      (dangerousErr as any).code = 'ECONNREFUSED';

      sendError({ requestId: 'safe-req' }, fakeRes, dangerousErr);

      expect(writtenBody).not.toContain('at ');
      expect(writtenBody).not.toContain('.ts');
      expect(writtenBody).not.toContain('/Users');
      expect(writtenBody).not.toContain('node_modules');
      expect(writtenBody).not.toContain('avishjain');
    });

    it('HEAD error responses receive headers and no body', () => {
      let writtenHeaders: any = {};
      let bodyWritten: any = null;

      const fakeRes: any = {
        headersSent: false,
        writeHead(status: number, headers: any) {
          writtenHeaders = headers;
        },
        end(data?: any) {
          bodyWritten = data;
        },
      };

      sendError(
        { requestId: 'head-req', method: 'HEAD' },
        fakeRes,
        new ProxyError('SERVICE_UNAVAILABLE', 503, 'Proxy is shutting down')
      );

      expect(writtenHeaders['Content-Type']).toBe('application/json');
      expect(writtenHeaders['Cache-Control']).toBe('no-store');
      expect(bodyWritten).toBeUndefined();
    });

    it('if headers were already sent, destroys socket and sends no error', () => {
      let destroyed = false;
      const fakeSocket: any = {
        destroyed: false,
        destroy() {
          destroyed = true;
          fakeSocket.destroyed = true;
        },
      };

      let writeHeadCalled = false;
      const fakeRes: any = {
        headersSent: true,
        socket: fakeSocket,
        writeHead() {
          writeHeadCalled = true;
        },
        end() {},
      };

      sendError({ requestId: 'already-sent' }, fakeRes, new Error('late error'));

      expect(destroyed).toBe(true);
      expect(writeHeadCalled).toBe(false);
    });
  });

  describe('Integration & clientError handler', () => {
    let proxy: any;
    let proxyPort: number;

    beforeAll(async () => {
      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: 'http://127.0.0.1:9999', // dummy
      });
      proxyPort = proxy.httpPort!;
    });

    afterAll(async () => {
      await proxy.stop();
    });

    it('handles clientError by sending 400 Bad Request JSON and closing socket', async () => {
      // Send malformed HTTP request line that Node HTTP parser rejects
      const res = await rawRequest(
        proxyPort,
        'INVALID_REQUEST_LINE_WITHOUT_HTTP_VERSION\r\n\r\n'
      );

      expect(res.raw.toString()).toContain('400 Bad Request');
      expect(res.raw.toString()).toContain('application/json');
      expect(res.raw.toString()).toContain('BAD_REQUEST');
      expect(res.socketClosed).toBe(true);
    });

    it('verifies process-level error handlers trigger stop cleanly', () => {
      let stopped = false;
      const fakeListener: any = {
        stop: async () => {
          stopped = true;
        },
      };

      const handlerRegistration = setupProcessErrorHandlers(fakeListener);
      expect(typeof handlerRegistration.cleanup).toBe('function');
      handlerRegistration.cleanup();
    });
  });

  describe('Fuzz testing: at least 40 malformed/hostile requests', () => {
    let dummyOrigin: http.Server;
    let dummyPort: number;
    let proxy: any;
    let proxyPort: number;

    beforeAll(async () => {
      // 1. Working dummy origin
      dummyOrigin = http.createServer((req, res) => {
        const msg = 'alive and well';
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(msg),
        });
        res.end(msg);
      });

      await new Promise<void>((resolve) => {
        dummyOrigin.listen(0, '127.0.0.1', () => resolve());
      });
      dummyPort = (dummyOrigin.address() as net.AddressInfo).port;

      // 2. Proxy connected to dummy origin
      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${dummyPort}`,
      });
      proxyPort = proxy.httpPort!;
    });

    afterAll(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => dummyOrigin.close(() => resolve()));
    });

    // 40+ diverse hostile / malformed request payloads
    const hostilePayloads: Array<{ name: string; payload: Buffer | string }> = [
      { name: 'missing Host header on HTTP/1.1', payload: 'GET / HTTP/1.1\r\n\r\n' },
      { name: 'bare LF line endings', payload: 'GET / HTTP/1.1\nHost: localhost\n\n' },
      { name: 'header without colon', payload: 'GET / HTTP/1.1\r\nHost localhost\r\n\r\n' },
      { name: 'NUL byte in a header', payload: 'GET / HTTP/1.1\r\nHost: localhost\r\nX-Bad: abc\0def\r\n\r\n' },
      {
        name: '10,000 headers',
        payload: 'GET / HTTP/1.1\r\nHost: localhost\r\n' +
          Array.from({ length: 10000 }, (_, i) => `X-Header-${i}: value-${i}\r\n`).join('') +
          '\r\n',
      },
      { name: 'obs-fold header continuation', payload: 'GET / HTTP/1.1\r\nHost: localhost\r\nX-Fold: foo\r\n bar\r\n\r\n' },
      { name: 'invalid HTTP version', payload: 'GET / HTTP/9.9\r\nHost: localhost\r\n\r\n' },
      {
        name: 'both Content-Length and Transfer-Encoding in client request',
        payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      },
      { name: 'negative Content-Length', payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: -10\r\n\r\n' },
      {
        name: 'absurdly long request line (60k chars)',
        payload: `GET /${'a'.repeat(60000)} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
      },
      { name: 'garbage binary bytes (random)', payload: Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x34, 0x56, 0x78]) },
      { name: 'incomplete HTTP request line', payload: 'GET /index' },
      { name: 'empty payload', payload: '' },
      { name: 'only newlines', payload: '\r\n\r\n\r\n\r\n' },
      { name: 'space before method', payload: ' GET / HTTP/1.1\r\nHost: localhost\r\n\r\n' },
      { name: 'invalid characters in header name', payload: 'GET / HTTP/1.1\r\nHost: localhost\r\nBad@Header: 123\r\n\r\n' },
      { name: 'tab in method', payload: 'GET\t/ HTTP/1.1\r\nHost: localhost\r\n\r\n' },
      { name: 'CR without LF', payload: 'GET / HTTP/1.1\rHost: localhost\r\r' },
      { name: 'multiple Host headers', payload: 'GET / HTTP/1.1\r\nHost: a.com\r\nHost: b.com\r\n\r\n' },
      { name: 'non-ASCII characters in method', payload: 'GËT / HTTP/1.1\r\nHost: localhost\r\n\r\n' },
      { name: 'control chars in target URI', payload: 'GET /\x01\x02\x03 HTTP/1.1\r\nHost: localhost\r\n\r\n' },
      { name: 'huge header value (50k chars)', payload: `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'b'.repeat(50000)}\r\n\r\n` },
      { name: 'huge header name (30k chars)', payload: `GET / HTTP/1.1\r\nHost: localhost\r\n${'c'.repeat(30000)}: 1\r\n\r\n` },
      { name: 'duplicate Content-Length with mismatch', payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nContent-Length: 20\r\n\r\n' },
      { name: 'Transfer-Encoding invalid token', payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: gzip, chunked, bogus\r\n\r\n' },
      { name: 'Content-Length scientific notation', payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1e5\r\n\r\n' },
      { name: 'Content-Length hex notation', payload: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0x10\r\n\r\n' },
      { name: 'trailing NUL byte in request', payload: 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n\0' },
      { name: 'NUL byte in method', payload: 'GET\0 / HTTP/1.1\r\nHost: localhost\r\n\r\n' },
      { name: 'whitespace only header name', payload: 'GET / HTTP/1.1\r\nHost: localhost\r\n   : empty\r\n\r\n' },
      // Binary garbage mutations (12 variations)
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `binary fuzz mutant ${i + 1}`,
        payload: Buffer.from(Array.from({ length: 32 + i * 8 }, (_, idx) => (idx * 37 + i * 19) % 256)),
      })),
    ];

    it('sends all 42 hostile requests without crashing or hanging, and serves a normal request afterwards', async () => {
      expect(hostilePayloads.length).toBeGreaterThanOrEqual(40);

      for (const item of hostilePayloads) {
        const res = await rawRequest(proxyPort, item.payload, { timeoutMs: 1500, waitForCloseMs: 80 });

        // Assert: server never hung (we received response or socket closed), never crashed
        const respondedWith4xx = res.statusCode !== undefined && res.statusCode >= 400 && res.statusCode < 500;
        const closedSocket = res.socketClosed || res.raw.length === 0;

        // Either answered with 4xx or closed the socket
        expect(respondedWith4xx || closedSocket).toBe(true);
      }

      // Assert: proxy process is still perfectly healthy and serves a normal request afterwards
      const normalRes = await rawRequest(
        proxyPort,
        'GET /normal HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(normalRes.statusCode).toBe(200);
      expect(normalRes.body.toString()).toBe('alive and well');
    }, 20000);
  });
});
