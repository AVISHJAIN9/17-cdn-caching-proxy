import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { originServer } from '../scripts/demo-origin.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { parseRequest } from '../src/proxy/request.js';
import { TimeoutManager } from '../src/proxy/timeouts.js';
import { streamOriginResponse } from '../src/proxy/stream.js';
import { createRequestContext } from '../src/proxy/context.js';

describe('Feature 4: Timeouts (src/proxy/timeouts.ts)', () => {
  let originPort: number;

  beforeAll(async () => {
    await new Promise<void>((r) => {
      originServer.listen(0, '127.0.0.1', () => r());
    });
    originPort = (originServer.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => originServer.close(() => r()));
  });

  it('/never-respond triggers headers timeout with 504 UPSTREAM_HEADERS_TIMEOUT', async () => {
    const timeoutMgr = new TimeoutManager({
      upstreamHeadersMs: 150, // 150ms timeout
    });

    const proxy = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res);
        if (!proxyReq) return;

        const ctx = createRequestContext(proxyReq.id);
        const upstreamReq = http.request(
          {
            host: '127.0.0.1',
            port: originPort,
            method: proxyReq.method,
            path: proxyReq.url,
          },
          (originRes) => {
            streamOriginResponse(originRes, res, proxyReq.method, { context: ctx });
          }
        );

        timeoutMgr.armUpstreamRequest(upstreamReq, res, proxyReq.id, ctx);
        upstreamReq.end();
      }
    );

    await proxy.start();
    const pPort = proxy.httpPort!;

    try {
      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: pPort,
            method: 'GET',
            path: '/never-respond',
          },
          (r) => {
            let data = '';
            r.on('data', (d) => (data += d));
            r.on('end', () => resolve({ statusCode: r.statusCode ?? 0, body: data }));
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(res.statusCode).toBe(504);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('UPSTREAM_HEADERS_TIMEOUT');
      expect(json.error.message).toMatch(/Upstream headers timed out/);
    } finally {
      await proxy.stop();
    }
  });

  it('/stall-after-headers triggers upstream idle timeout and destroys client socket', async () => {
    const timeoutMgr = new TimeoutManager({
      upstreamIdleMs: 120, // 120ms gap limit between chunks
    });

    const proxy = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res);
        if (!proxyReq) return;

        const ctx = createRequestContext(proxyReq.id);
        let arms: any;

        const upstreamReq = http.request(
          {
            host: '127.0.0.1',
            port: originPort,
            method: proxyReq.method,
            path: proxyReq.url,
          },
          (originRes) => {
            if (arms) arms.onHeadersReceived(originRes);
            streamOriginResponse(originRes, res, proxyReq.method, { context: ctx }).catch(() => {});
          }
        );

        arms = timeoutMgr.armUpstreamRequest(upstreamReq, res, proxyReq.id, ctx);
        upstreamReq.end();
      }
    );

    await proxy.start();
    const pPort = proxy.httpPort!;

    try {
      let clientSawAborted = false;
      let clientSawCleanEnd = false;

      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: pPort,
            method: 'GET',
            path: '/stall-after-headers',
          },
          (r) => {
            r.on('data', () => {});
            r.on('end', () => {
              clientSawCleanEnd = true;
              resolve();
            });
            r.on('close', () => {
              if (!clientSawCleanEnd) clientSawAborted = true;
              resolve();
            });
            r.on('error', () => {
              clientSawAborted = true;
              resolve();
            });
          }
        );
        req.on('error', () => {
          clientSawAborted = true;
          resolve();
        });
        req.end();
      });

      expect(clientSawAborted).toBe(true);
      expect(clientSawCleanEnd).toBe(false);
    } finally {
      await proxy.stop();
    }
  });

  it('slowloris client that sends headers byte-by-byte is cut off by clientHeadersMs', async () => {
    const timeoutMgr = new TimeoutManager({
      clientHeadersMs: 150, // 150ms limit to finish sending headers
    });

    const proxy = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      (req, res) => {
        res.end('ok');
      }
    );

    await proxy.start();
    const pPort = proxy.httpPort!;
    timeoutMgr.applyServerTimeouts((proxy as any).httpServer);

    try {
      let socketDestroyedByServer = false;

      await new Promise<void>((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: pPort }, () => {
          // Send initial part of HTTP request header
          sock.write('GET /slowloris HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');

          // Drip 1 byte every 60ms (will exceed 150ms headersTimeout)
          const interval = setInterval(() => {
            if (sock.destroyed) {
              clearInterval(interval);
              return;
            }
            try {
              sock.write('a');
            } catch {
              clearInterval(interval);
            }
          }, 60);

          sock.on('close', () => {
            clearInterval(interval);
            socketDestroyedByServer = true;
            resolve();
          });

          sock.on('error', () => {
            clearInterval(interval);
            socketDestroyedByServer = true;
            resolve();
          });
        });
      });

      expect(socketDestroyedByServer).toBe(true);
    } finally {
      await proxy.stop();
    }
  });

  it('upstream connect timeout triggers 504 on non-routable IP (or 502 if unreachable)', async () => {
    const timeoutMgr = new TimeoutManager({
      upstreamConnectMs: 100, // 100ms connect timeout
    });

    const proxy = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        handleSignals: false,
      },
      async (req, res) => {
        const proxyReq = await parseRequest(req, res);
        if (!proxyReq) return;

        const ctx = createRequestContext(proxyReq.id);
        const upstreamReq = http.request(
          {
            host: '192.0.2.1', // RFC 5737 TEST-NET-1 non-routable
            port: 80,
            method: 'GET',
            path: '/',
          },
          () => {}
        );

        upstreamReq.on('error', (err: any) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: err.message } }));
          }
        });

        timeoutMgr.armUpstreamRequest(upstreamReq, res, proxyReq.id, ctx);
        upstreamReq.end();
      }
    );

    await proxy.start();
    const pPort = proxy.httpPort!;

    try {
      const result = await new Promise<{ statusCode: number; code?: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: pPort,
            method: 'GET',
            path: '/',
          },
          (r) => {
            let data = '';
            r.on('data', (d) => (data += d));
            r.on('end', () => {
              try {
                const j = JSON.parse(data);
                resolve({ statusCode: r.statusCode ?? 0, code: j?.error?.code });
              } catch {
                resolve({ statusCode: r.statusCode ?? 0 });
              }
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

      // Assert it maps to 504 (UPSTREAM_CONNECT_TIMEOUT) or 502 (BAD_GATEWAY if immediate unreachable)
      expect([504, 502]).toContain(result.statusCode);
      if (result.statusCode === 504) {
        expect(result.code).toBe('UPSTREAM_CONNECT_TIMEOUT');
      }
    } finally {
      await proxy.stop();
    }
  });
});
