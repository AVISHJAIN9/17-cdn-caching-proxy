import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { parseRequest, ProxyRequest } from '../src/proxy/request.js';
import { ProxyListener } from '../src/proxy/listener.js';

interface RequestResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function sendHttpRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | number>;
    body?: string | Buffer;
    rawPath?: string;
  } = {}
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.rawPath ?? options.path ?? '/',
        headers: options.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          });
        });
      }
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('Feature 2: Request parsing', () => {
  let listener: ProxyListener;
  let port: number;
  let lastParsedRequest: ProxyRequest | null = null;
  let parserConfig = {};

  beforeAll(async () => {
    listener = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const parsed = await parseRequest(req, res, parserConfig);
        lastParsedRequest = parsed;
        if (parsed) {
          // If body is present, consume it
          let bodyText = '';
          parsed.body.on('data', (chunk) => {
            bodyText += chunk.toString();
          });
          parsed.body.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: parsed.id,
                method: parsed.method,
                rawTarget: parsed.rawTarget,
                url: parsed.url,
                receivedBody: bodyText,
              })
            );
          });
        }
      }
    );
    await listener.start();
    port = listener.httpPort!;
  });

  afterAll(async () => {
    await listener.stop();
  });

  it('parses valid GET request correctly with generated X-Request-Id', async () => {
    parserConfig = {};
    const res = await sendHttpRequest(port, {
      method: 'GET',
      path: '/test?query=hello',
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.method).toBe('GET');
    expect(data.rawTarget).toBe('/test?query=hello');
    expect(data.url).toBe('/test?query=hello');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toBe(data.id);
  });

  it('parses valid POST request with body stream', async () => {
    parserConfig = {};
    const payload = JSON.stringify({ message: 'hello world' });
    const res = await sendHttpRequest(port, {
      method: 'POST',
      path: '/submit',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      body: payload,
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.method).toBe('POST');
    expect(data.receivedBody).toBe(payload);
  });

  it('accepts absolute-form targets and normalizes them', async () => {
    parserConfig = {};
    const res = await sendHttpRequest(port, {
      method: 'GET',
      rawPath: 'http://Example.COM:80/a/./b/../c?q=1',
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.rawTarget).toBe('http://Example.COM:80/a/./b/../c?q=1');
    expect(data.url).toBe('http://example.com/a/c?q=1');
  });

  it('honors valid incoming X-Request-Id and returns it in the response header', async () => {
    parserConfig = {};
    const customId = 'client-trace-12345.abc_XYZ';
    const res = await sendHttpRequest(port, {
      method: 'GET',
      path: '/trace',
      headers: {
        'X-Request-Id': customId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
    const data = JSON.parse(res.body);
    expect(data.id).toBe(customId);
  });

  it('replaces invalid X-Request-Id with safe generated UUID', async () => {
    parserConfig = {};
    const unsafeId = 'invalid id with spaces & symbols <script>';
    const res = await sendHttpRequest(port, {
      method: 'GET',
      path: '/trace',
      headers: {
        'X-Request-Id': unsafeId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).not.toBe(unsafeId);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('rejects unsupported HTTP methods with 501 and disallowed methods with 405', async () => {
    parserConfig = {};
    const res501 = await sendHttpRequest(port, {
      method: 'PURGE',
      path: '/unsupported',
    });

    expect(res501.statusCode).toBe(501);
    const json501 = JSON.parse(res501.body);
    expect(json501.error.code).toBe('NOT_IMPLEMENTED');
    expect(json501.error.requestId).toBeDefined();
    expect(res501.headers['x-request-id']).toBe(json501.error.requestId);

    const res405 = await sendHttpRequest(port, {
      method: 'TRACE',
      path: '/unsupported',
    });

    expect(res405.statusCode).toBe(405);
    expect(res405.headers['allow']).toBeDefined();
    const json405 = JSON.parse(res405.body);
    expect(json405.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('rejects invalid percent-encoding with 400', async () => {
    parserConfig = {};
    const res = await sendHttpRequest(port, {
      method: 'GET',
      rawPath: '/bad%zzpath',
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe('INVALID_PERCENT_ENCODING');
    expect(json.error.requestId).toBeDefined();
  });

  it('rejects headers exceeding maxHeaderBytes with 431', async () => {
    // Configure small header threshold (500 bytes)
    parserConfig = { maxHeaderBytes: 500 };
    const largeHeaderValue = 'X'.repeat(800);
    const res = await sendHttpRequest(port, {
      method: 'GET',
      path: '/large-headers',
      headers: {
        'X-Custom-Large': largeHeaderValue,
      },
    });

    expect(res.statusCode).toBe(431);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe('HEADERS_TOO_LARGE');
    expect(json.error.requestId).toBeDefined();
  });

  it('rejects body exceeding maxBodyBytes with 413 (via Content-Length)', async () => {
    parserConfig = { maxBodyBytes: 1024 }; // 1 KB limit
    const res = await sendHttpRequest(port, {
      method: 'POST',
      path: '/oversized-body',
      headers: {
        'Content-Length': 5000,
      },
      body: Buffer.alloc(100),
    });

    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error.requestId).toBeDefined();
  });

  it('rejects body exceeding maxBodyBytes with 413 (via streaming chunks)', async () => {
    parserConfig = { maxBodyBytes: 256 }; // 256 bytes limit
    const chunkData = Buffer.alloc(1000, 'a');

    const res = await sendHttpRequest(port, {
      method: 'POST',
      path: '/streaming-oversized',
      // No Content-Length to test streaming enforcement
      body: chunkData,
    });

    expect(res.statusCode).toBe(413);
    const json = JSON.parse(res.body);
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error.requestId).toBeDefined();
  });
});
