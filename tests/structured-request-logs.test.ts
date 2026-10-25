import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { RequestLogger } from '../src/observability/logger.js';
import { SystemClock } from '../src/util/clock.js';

describe('Feature 94 & 95: Structured Request Logs', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('slow response');
          }
        }, 100);
        return;
      }

      if (req.url?.startsWith('/error-500')) {
        res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Internal Server Error');
        return;
      }

      if (req.url?.startsWith('/cached')) {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
          ETag: '"log-test-1"',
        });
        res.end('cached-content');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      res.end('hello origin');
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        const addr = originServer.address() as net.AddressInfo;
        originPort = addr.port;
        originUrl = `http://127.0.0.1:${originPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const proxy of activeProxies) {
      await proxy.stop();
    }
    activeProxies = [];
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('Feature 94: emits valid structured JSON lines with stable schema fields', async () => {
    const emittedLines: string[] = [];
    const logger = new RequestLogger({
      outputStream: (line: string) => emittedLines.push(line),
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      logger,
    });
    activeProxies.push(proxy);

    const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/api/resource?category=books`);
    expect(res.status).toBe(200);

    // Wait for queue flush
    await new Promise((r) => setTimeout(r, 50));

    expect(emittedLines.length).toBe(1);
    const parsed = JSON.parse(emittedLines[0]);

    expect(parsed).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/api/resource?category=books',
      statusCode: 200,
      cache: 'MISS',
    });

    expect(typeof parsed.timestamp).toBe('string');
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date');
    expect(typeof parsed.requestId).toBe('string');
    expect(parsed.requestId.length).toBeGreaterThan(0);
    expect(typeof parsed.durationMs).toBe('number');
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof parsed.bytesSent).toBe('number');
    expect(parsed.bytesSent).toBeGreaterThan(0);
  });

  it('Feature 95: logs exactly one line on success, 4xx, 5xx, and client abort', async () => {
    const emittedLines: string[] = [];
    const logger = new RequestLogger({
      outputStream: (line: string) => emittedLines.push(line),
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      logger,
      allowedMethods: ['GET', 'POST'],
    });
    activeProxies.push(proxy);

    // 1. Success 200
    const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/ok`);
    expect(res1.status).toBe(200);

    // 2. Client error 405 (Method Not Allowed)
    const res2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/test-method`, { method: 'DELETE' });
    expect(res2.status).toBe(405);

    // 3. Server error 500
    const res3 = await fetch(`http://127.0.0.1:${proxy.httpPort}/error-500`);
    expect(res3.status).toBe(500);

    // 4. Client abort / socket destroy
    await new Promise<void>((resolve) => {
      const client = net.createConnection({ host: '127.0.0.1', port: proxy.httpPort! }, () => {
        client.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 20);
      });
    });

    await new Promise((r) => setTimeout(r, 150));

    expect(emittedLines.length).toBe(4);
    const parsedLogs = emittedLines.map((l) => JSON.parse(l));

    const statusCodes = parsedLogs.map((p) => p.statusCode);
    expect(statusCodes).toContain(200);
    expect(statusCodes).toContain(405);
    expect(statusCodes).toContain(500);

    // One error log for 500, warn for 405, info for 200
    const log200 = parsedLogs.find((p) => p.statusCode === 200);
    expect(log200.level).toBe('info');

    const log405 = parsedLogs.find((p) => p.statusCode === 405);
    expect(log405.level).toBe('warn');

    const log500 = parsedLogs.find((p) => p.statusCode === 500);
    expect(log500.level).toBe('error');
  });

  it('Feature 95: propagates incoming X-Request-Id or generates unique ID', async () => {
    const emittedLines: string[] = [];
    const logger = new RequestLogger({
      outputStream: (line: string) => emittedLines.push(line),
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      logger,
    });
    activeProxies.push(proxy);

    // Request with custom X-Request-Id
    const resCustom = await fetch(`http://127.0.0.1:${proxy.httpPort}/test-id-1`, {
      headers: { 'X-Request-Id': 'req-custom-998877' },
    });
    expect(resCustom.headers.get('x-request-id')).toBe('req-custom-998877');

    // Request without X-Request-Id
    const resGenerated = await fetch(`http://127.0.0.1:${proxy.httpPort}/test-id-2`);
    const generatedId = resGenerated.headers.get('x-request-id');
    expect(generatedId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 50));

    const logs = emittedLines.map((l) => JSON.parse(l));
    const customLog = logs.find((l) => l.path === '/test-id-1');
    const genLog = logs.find((l) => l.path === '/test-id-2');

    expect(customLog.requestId).toBe('req-custom-998877');
    expect(genLog.requestId).toBe(generatedId);
  });

  it('Feature 94 & 95: redacts sensitive query parameters in logged path', async () => {
    const emittedLines: string[] = [];
    const logger = new RequestLogger({
      outputStream: (line: string) => emittedLines.push(line),
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      logger,
    });
    activeProxies.push(proxy);

    await fetch(
      `http://127.0.0.1:${proxy.httpPort}/search?token=supersecret123&apiKey=key_abc&safeParam=visible&auth=jwt_xyz`
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(emittedLines.length).toBe(1);
    const parsed = JSON.parse(emittedLines[0]);

    expect(parsed.path).not.toContain('supersecret123');
    expect(parsed.path).not.toContain('key_abc');
    expect(parsed.path).not.toContain('jwt_xyz');
    expect(parsed.path).toContain('token=%5BREDACTED%5D');
    expect(parsed.path).toContain('safeParam=visible');
  });

  it('Feature 94: non-blocking queue bounds and drop counter under floods', async () => {
    const emittedLines: string[] = [];
    // Logger bounded to maxQueueSize = 5
    const boundedLogger = new RequestLogger({
      maxQueueSize: 5,
      outputStream: (line: string) => emittedLines.push(line),
    });

    // Directly push 15 records synchronously before flush
    for (let i = 0; i < 15; i++) {
      boundedLogger.log({
        timestamp: new Date().toISOString(),
        level: 'info',
        requestId: `flood-req-${i}`,
        method: 'GET',
        path: `/item/${i}`,
        statusCode: 200,
        durationMs: 1,
        cache: 'HIT',
        bytesSent: 100,
      });
    }

    // Drops occurred
    expect(boundedLogger.getDroppedCount()).toBe(10);

    await new Promise((r) => setTimeout(r, 50));
    expect(emittedLines.length).toBe(5);
  });

  it('Feature 95: attributes tenant correctly when authenticated or header specified', async () => {
    const emittedLines: string[] = [];
    const logger = new RequestLogger({
      outputStream: (line: string) => emittedLines.push(line),
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      logger,
      apiKeyAuth: {
        keys: [{ id: 'k1', key: 'secret-key-1', tenantId: 'tenant-enterprise' }],
      },
    });
    activeProxies.push(proxy);

    await fetch(`http://127.0.0.1:${proxy.httpPort}/secure-data`, {
      headers: { 'X-Api-Key': 'secret-key-1' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(emittedLines.length).toBe(1);
    const parsed = JSON.parse(emittedLines[0]);
    expect(parsed.tenant).toBe('tenant-enterprise');
  });
});
