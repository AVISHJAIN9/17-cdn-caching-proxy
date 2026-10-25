import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { UpstreamClient } from '../src/proxy/upstream.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 62: Connection pooling', () => {
  let originServer: http.Server;
  let originPort: number;
  let serverConnectionCount = 0;
  let activeServerConnections = 0;

  beforeAll(async () => {
    originServer = http.createServer((req, res) => {
      // Delay response slightly if /slow requested to inspect concurrent connections
      const delay = req.url?.includes('slow') ? 80 : 10;
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'connection': 'keep-alive',
          'keep-alive': 'timeout=5',
        });
        res.end(JSON.stringify({ status: 'ok', url: req.url }));
      }, delay);
    });

    originServer.on('connection', (socket: net.Socket) => {
      serverConnectionCount++;
      activeServerConnections++;
      socket.on('close', () => {
        activeServerConnections--;
      });
    });

    await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', () => r()));
    originPort = (originServer.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => originServer.close(() => r()));
  });

  describe('Socket Reuse & Pool Observability', () => {
    it('reuses open keepalive connection for sequential requests to same origin', async () => {
      const client = new UpstreamClient({ keepAlive: true, maxSockets: 10 });
      const targetUrl = new URL(`http://127.0.0.1:${originPort}/test`);

      const initialConnections = serverConnectionCount;

      // 1st request
      await new Promise<void>((resolve, reject) => {
        const req = client.request(
          {
            url: targetUrl,
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
          reject
        );
      });

      // 2nd request
      await new Promise<void>((resolve, reject) => {
        const req = client.request(
          {
            url: targetUrl,
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
          reject
        );
      });

      // The two requests should have shared 1 connection
      const connectionsOpened = serverConnectionCount - initialConnections;
      expect(connectionsOpened).toBe(1);

      // Verify stats API
      const stats = client.getPoolStats();
      expect(stats.freeSockets).toBeGreaterThanOrEqual(1);
      expect(stats.activeSockets).toBe(0);

      client.destroy();
    });

    it('enforces maxSockets concurrency limit per origin', async () => {
      const client = new UpstreamClient({ keepAlive: true });
      const originId = 'constrained-origin';
      const targetUrl = new URL(`http://127.0.0.1:${originPort}/slow`);

      let maxObservedActive = 0;

      // Launch 6 concurrent requests with maxSockets: 2
      const promises = Array.from({ length: 6 }).map((_, i) => {
        return new Promise<void>((resolve, reject) => {
          client.request(
            {
              url: targetUrl,
              method: 'GET',
              originId,
              maxSockets: 2,
              headers: { host: `127.0.0.1:${originPort}` },
            },
            (res) => {
              const currentActive = client.getPoolStats(originId).activeSockets;
              if (currentActive > maxObservedActive) {
                maxObservedActive = currentActive;
              }
              res.resume();
              res.on('end', () => resolve());
            },
            reject
          );
        });
      });

      await Promise.all(promises);

      // Active sockets must not exceed maxSockets (2)
      expect(maxObservedActive).toBeLessThanOrEqual(2);
      expect(maxObservedActive).toBeGreaterThanOrEqual(1);

      client.destroy();
    });

    it('cleans up all sockets and resets stats on destroy()', () => {
      const client = new UpstreamClient({ keepAlive: true });
      client.destroy();

      const stats = client.getPoolStats();
      expect(stats.activeSockets).toBe(0);
      expect(stats.freeSockets).toBe(0);
      expect(stats.pendingRequests).toBe(0);
    });
  });

  describe('End-to-End Proxy Connection Pooling', () => {
    it('shares connection pool across incoming proxy requests', async () => {
      const proxy = await createAndStartProxy({
        port: 0,
        originsConfig: {
          origins: {
            default: {
              url: `http://127.0.0.1:${originPort}`,
              maxSockets: 4,
            },
          },
          defaultOrigin: 'default',
        },
      });

      const initialConnections = serverConnectionCount;

      try {
        // Send 5 sequential requests through proxy
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/pool-seq-${i}`);
          expect(res.status).toBe(200);
        }

        // All 5 sequential requests should reuse the single keep-alive connection
        const newConnections = serverConnectionCount - initialConnections;
        expect(newConnections).toBe(1);
      } finally {
        await proxy.close();
      }
    });
  });
});
