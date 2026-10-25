import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { ProxyListener } from '../src/proxy/listener.js';
import { parseRequest } from '../src/proxy/request.js';
import { RequestForwarder } from '../src/proxy/forward.js';

function makeRequest(
  options: http.RequestOptions,
  body?: Buffer | string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('Feature 5: Request forwarding', () => {
  let originServer: http.Server;
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let forwarder: RequestForwarder;
  let originAborted = false;

  beforeAll(async () => {
    // 1. Start real local HTTP origin server
    originServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname === '/hello') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from origin!');
        return;
      }

      if (url.pathname === '/echo-headers') {
        let bodyData = '';
        req.on('data', (chunk) => {
          bodyData += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              headers: req.headers,
              method: req.method,
              receivedBody: bodyData,
            })
          );
        });
        return;
      }

      if (url.pathname.startsWith('/status/')) {
        const code = parseInt(url.pathname.slice(8), 10);
        res.writeHead(isNaN(code) ? 500 : code, { 'Content-Type': 'text/plain' });
        res.end(`Origin status ${code}`);
        return;
      }

      if (url.pathname === '/query-check') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Query: ${url.search}`);
        return;
      }

      if (url.pathname === '/slow-stream') {
        res.on('close', () => {
          originAborted = true;
        });
        // Write headers and drip data
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('part1...');
        // Never finishes unless aborted
        return;
      }

      if (url.pathname === '/large-payload') {
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ receivedBytes: size }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found at origin');
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => resolve());
    });
    originPort = (originServer.address() as any).port;

    // 2. Start proxy configured with RequestForwarder to local origin
    forwarder = new RequestForwarder({
      origin: { url: `http://127.0.0.1:${originPort}` },
    });

    proxyListener = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res, {
          maxBodyBytes: 15 * 1024 * 1024, // allow 15 MB for test
        });
        if (proxyReq) {
          forwarder.forward(proxyReq, res, req);
        }
      }
    );

    await proxyListener.start();
    proxyPort = proxyListener.httpPort!;
  });

  afterAll(async () => {
    await proxyListener.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('forwards GET request and returns origin response', async () => {
    const res = await makeRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: '/hello',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('Hello from origin!');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('forwards POST request with body stream', async () => {
    const payload = JSON.stringify({ item: 'laptop', price: 999 });
    const res = await makeRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'POST',
        path: '/echo-headers',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      payload
    );
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body.toString());
    expect(json.method).toBe('POST');
    expect(json.receivedBody).toBe(payload);
  });

  it('preserves query strings during forwarding', async () => {
    const res = await makeRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: '/query-check?category=books&sort=desc&page=2',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('Query: ?category=books&sort=desc&page=2');
  });

  it('forwards normalized headers correctly to /echo-headers', async () => {
    const res = await makeRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: '/echo-headers',
      headers: {
        'User-Agent': 'vitest-client',
        'X-Custom': 'my-header-val',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body.toString());
    const originHeaders = json.headers;

    // Origin receives normalized headers
    expect(originHeaders['user-agent']).toBe('vitest-client');
    expect(originHeaders['x-custom']).toBe('my-header-val');
    expect(originHeaders['via']).toBe('1.1 cdn-proxy');
    expect(originHeaders['x-forwarded-for']).toBe('127.0.0.1');
    expect(originHeaders['x-forwarded-proto']).toBe('http');
    expect(originHeaders['host']).toBe(`127.0.0.1:${originPort}`);
  });

  it('origin 404 and 500 status codes pass through unchanged', async () => {
    const res404 = await makeRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: '/status/404',
    });
    expect(res404.statusCode).toBe(404);
    expect(res404.body.toString()).toBe('Origin status 404');

    const res500 = await makeRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: '/status/500',
    });
    expect(res500.statusCode).toBe(500);
    expect(res500.body.toString()).toBe('Origin status 500');
  });

  it('returns 502 with JSON error body when origin is down', async () => {
    // Configure forwarder pointing to closed port (port 1)
    const deadForwarder = new RequestForwarder({
      origin: { url: 'http://127.0.0.1:1' },
    });

    const deadListener = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res);
        if (proxyReq) {
          deadForwarder.forward(proxyReq, res, req);
        }
      }
    );
    await deadListener.start();
    const deadProxyPort = deadListener.httpPort!;

    try {
      const res = await makeRequest({
        host: '127.0.0.1',
        port: deadProxyPort,
        method: 'GET',
        path: '/any-path',
      });

      expect(res.statusCode).toBe(502);
      const json = JSON.parse(res.body.toString());
      expect(json.error.code).toBe('BAD_GATEWAY');
      expect(json.error.message).toMatch(/Origin connection failed|ECONNREFUSED/i);
      expect(json.error.requestId).toBeDefined();
    } finally {
      await deadListener.stop();
    }
  });

  it('destroys upstream request when client aborts', async () => {
    originAborted = false;

    await new Promise<void>((resolve) => {
      const clientReq = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: '/slow-stream',
        },
        (res) => {
          res.on('data', () => {
            // Client receives initial chunk, then aborts
            clientReq.destroy();
          });
        }
      );

      clientReq.on('error', () => {
        // expected on abort
      });

      clientReq.end();

      const checkInterval = setInterval(() => {
        if (originAborted) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 20);

      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 1000);
    });

    expect(originAborted).toBe(true);
  });

  it('streams a 5 MB body through to origin without full buffering', async () => {
    const size5MB = 5 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 'z'); // 64 KB chunks
    const totalChunks = size5MB / chunk.length;

    const resPromise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const clientReq = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/large-payload',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': size5MB,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
        }
      );

      clientReq.on('error', reject);

      for (let i = 0; i < totalChunks; i++) {
        clientReq.write(chunk);
      }
      clientReq.end();
    });

    const res = await resPromise;
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.receivedBytes).toBe(size5MB);
  });
});
