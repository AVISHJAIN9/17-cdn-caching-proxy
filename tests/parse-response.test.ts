import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { parseUpstreamResponse, UpstreamResponseError } from '../src/proxy/parse-response.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 2: Response parsing (src/proxy/parse-response.ts)', () => {
  describe('Unit tests: parseUpstreamResponse', () => {
    it('parses chunked response properly', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          statusMessage: 'OK',
          httpVersion: '1.1',
          headers: {
            'content-type': 'text/plain',
            'transfer-encoding': 'chunked',
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.statusCode).toBe(200);
      expect(parsed.isChunked).toBe(true);
      expect(parsed.contentLength).toBeNull();
      expect(parsed.hasBody).toBe(true);
      expect(parsed.isInterim).toBe(false);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.headers)).toBe(true);
    });

    it('parses content-length response properly', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          statusMessage: 'OK',
          httpVersion: '1.1',
          headers: {
            'content-length': '42',
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.contentLength).toBe(42);
      expect(parsed.isChunked).toBe(false);
      expect(parsed.hasBody).toBe(true);
    });

    it('computes hasBody = false for HEAD request with content-length', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          statusMessage: 'OK',
          httpVersion: '1.1',
          headers: {
            'content-length': '1024',
          },
        },
        { requestMethod: 'HEAD' }
      );

      expect(parsed.contentLength).toBe(1024);
      expect(parsed.hasBody).toBe(false);
    });

    it('computes hasBody = false for 204 No Content', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 204,
          statusMessage: 'No Content',
          httpVersion: '1.1',
          headers: {},
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.hasBody).toBe(false);
    });

    it('computes hasBody = false for 304 Not Modified', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 304,
          statusMessage: 'Not Modified',
          httpVersion: '1.1',
          headers: {
            etag: '"v1"',
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.hasBody).toBe(false);
    });

    it('throws UPSTREAM_INVALID_RESPONSE for conflicting Content-Lengths', () => {
      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 200,
            headers: {
              'content-length': '10, 20',
            },
          },
          { requestMethod: 'GET' }
        );
      }).toThrowError(UpstreamResponseError);

      try {
        parseUpstreamResponse(
          {
            statusCode: 200,
            headers: {
              'content-length': '10, 20',
            },
          },
          { requestMethod: 'GET' }
        );
      } catch (err: any) {
        expect(err.code).toBe('UPSTREAM_INVALID_RESPONSE');
        expect(err.statusCode).toBe(502);
      }
    });

    it('allows identical multiple Content-Lengths', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          headers: {
            'content-length': '42, 42',
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.contentLength).toBe(42);
    });

    it('throws UPSTREAM_INVALID_RESPONSE for non-numeric or negative Content-Length', () => {
      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 200,
            headers: {
              'content-length': 'invalid-number',
            },
          },
          { requestMethod: 'GET' }
        );
      }).toThrowError(UpstreamResponseError);

      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 200,
            headers: {
              'content-length': '-10',
            },
          },
          { requestMethod: 'GET' }
        );
      }).toThrowError(UpstreamResponseError);
    });

    it('if both Content-Length and Transfer-Encoding: chunked are present, chunked wins and Content-Length is ignored', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          headers: {
            'transfer-encoding': 'chunked',
            'content-length': '50',
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.isChunked).toBe(true);
      expect(parsed.contentLength).toBeNull();
      expect(parsed.hasBody).toBe(true);
    });

    it('validates 1xx interim responses when isFinal: false', () => {
      const interim = parseUpstreamResponse(
        {
          statusCode: 103,
          statusMessage: 'Early Hints',
          headers: {
            link: '</style.css>; rel=preload; as=style',
          },
        },
        { requestMethod: 'GET', isFinal: false }
      );

      expect(interim.statusCode).toBe(103);
      expect(interim.isInterim).toBe(true);
      expect(interim.hasBody).toBe(false);
    });

    it('rejects status code < 200 for final response', () => {
      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 103,
            statusMessage: 'Early Hints',
            headers: {},
          },
          { requestMethod: 'GET', isFinal: true }
        );
      }).toThrowError(UpstreamResponseError);
    });

    it('rejects status code > 599 or < 100', () => {
      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 601,
            headers: {},
          },
          { requestMethod: 'GET' }
        );
      }).toThrowError(UpstreamResponseError);

      expect(() => {
        parseUpstreamResponse(
          {
            statusCode: 99,
            headers: {},
          },
          { requestMethod: 'GET' }
        );
      }).toThrowError(UpstreamResponseError);
    });

    it('preserves Set-Cookie array without flattening or comma-joining', () => {
      const parsed = parseUpstreamResponse(
        {
          statusCode: 200,
          headers: {
            'set-cookie': ['cookie1=val1; Path=/', 'cookie2=val2; Secure'],
          },
        },
        { requestMethod: 'GET' }
      );

      expect(parsed.setCookies).toEqual(['cookie1=val1; Path=/', 'cookie2=val2; Secure']);
      expect(parsed.headers['set-cookie']).toEqual(['cookie1=val1; Path=/', 'cookie2=val2; Secure']);
    });
  });

  describe('Integration with real TCP origin sending raw bytes', () => {
    let originServer: net.Server;
    let originPort: number;
    let proxyServer: any;
    let proxyPort: number;

    // Custom raw response generator per test
    let rawResponseHandler: (socket: net.Socket) => void = () => {};

    beforeAll(async () => {
      // 1. Raw TCP origin
      originServer = net.createServer((socket) => {
        socket.on('data', () => {
          rawResponseHandler(socket);
        });
      });

      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => resolve());
      });
      originPort = (originServer.address() as net.AddressInfo).port;

      // 2. Proxy connected to raw origin
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

    it('forwards chunked response from origin', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          '5\r\nhello\r\n' +
          '6\r\n world\r\n' +
          '0\r\n\r\n'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /test-chunked HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toContain('hello');
      expect(res.body.toString()).toContain('world');
    });

    it('forwards content-length response from origin', async () => {
      const body = 'Plain content-length body';
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          body
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /test-cl HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe(String(body.length));
      expect(res.body.toString()).toBe(body);
    });

    it('forwards HEAD with content-length but no body', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: 1024\r\n' +
          'Content-Type: application/octet-stream\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'HEAD /test-head HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe('1024');
      expect(res.body.length).toBe(0);
    });

    it('forwards 204 No Content with no body', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 204 No Content\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /test-204 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(204);
      expect(res.body.length).toBe(0);
    });

    it('forwards 304 Not Modified with no body', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 304 Not Modified\r\n' +
          'ETag: "abc-123"\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /test-304 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(304);
      expect(res.headers['etag']).toBe('"abc-123"');
      expect(res.body.length).toBe(0);
    });

    it('returns 502 UPSTREAM_INVALID_RESPONSE for conflicting Content-Lengths', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: 10\r\n' +
          'Content-Length: 20\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          '0123456789'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /conflicting-cl HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(502);
      const json = JSON.parse(res.body.toString());
      expect(json.error.code).toBe('UPSTREAM_INVALID_RESPONSE');
    });

    it('returns 502 UPSTREAM_INVALID_RESPONSE for non-numeric Content-Length', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: abc\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'hello'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /non-numeric-cl HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(502);
      const json = JSON.parse(res.body.toString());
      expect(json.error.code).toBe('UPSTREAM_INVALID_RESPONSE');
    });

    it('handles 103 Early Hints followed by 200 OK', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 103 Early Hints\r\n' +
          'Link: </style.css>; rel=preload; as=style\r\n' +
          '\r\n' +
          'HTTP/1.1 200 OK\r\n' +
          'Content-Type: text/html\r\n' +
          'Content-Length: 13\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          '<h1>Done</h1>'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /early-hints HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // The raw bytes will contain the 103 or final 200 response
      expect(res.raw.toString()).toContain('200 OK');
      expect(res.body.toString()).toContain('<h1>Done</h1>');
    });

    it('preserves multiple set-cookie headers through proxy', async () => {
      rawResponseHandler = (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Set-Cookie: session=xyz; HttpOnly\r\n' +
          'Set-Cookie: theme=dark; Path=/\r\n' +
          'Content-Length: 2\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'ok'
        );
      };

      const res = await rawRequest(
        proxyPort,
        'GET /cookies HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies).toEqual(['session=xyz; HttpOnly', 'theme=dark; Path=/']);
    });
  });
});
