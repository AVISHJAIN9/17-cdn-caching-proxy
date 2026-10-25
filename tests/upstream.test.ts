import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import selfsigned from 'selfsigned';
import {
  UpstreamClient,
  shouldRetryOnStaleSocket,
} from '../src/proxy/upstream.js';

describe('Feature 3: Upstream connections (src/proxy/upstream.ts)', () => {
  describe('Unit tests: shouldRetryOnStaleSocket', () => {
    it('returns true only for idempotent methods on reused socket with stale error and no body', () => {
      const errReset = { code: 'ECONNRESET', message: 'read ECONNRESET' };
      const errHangup = { message: 'socket hang up' };
      const errPipe = { code: 'EPIPE', message: 'write EPIPE' };

      // Valid cases
      expect(shouldRetryOnStaleSocket(errReset, 'GET', true, false)).toBe(true);
      expect(shouldRetryOnStaleSocket(errHangup, 'HEAD', true, false)).toBe(true);
      expect(shouldRetryOnStaleSocket(errPipe, 'OPTIONS', true, false)).toBe(true);

      // Non-idempotent methods must never retry
      expect(shouldRetryOnStaleSocket(errReset, 'POST', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(errReset, 'PUT', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(errReset, 'DELETE', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(errReset, 'PATCH', true, false)).toBe(false);

      // Fresh sockets (not reused) must not retry under this rule
      expect(shouldRetryOnStaleSocket(errReset, 'GET', false, false)).toBe(false);

      // If body was started, must not retry
      expect(shouldRetryOnStaleSocket(errReset, 'GET', true, true)).toBe(false);

      // Unrelated errors must not retry
      expect(shouldRetryOnStaleSocket({ code: 'ENOTFOUND' }, 'GET', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket({ code: 'ETIMEDOUT' }, 'GET', true, false)).toBe(false);
      expect(shouldRetryOnStaleSocket(null, 'GET', true, false)).toBe(false);
    });
  });

  describe('Integration tests: Keep-alive reuse and pooling', () => {
    let server: http.Server;
    let serverPort: number;
    let connectionsCount = 0;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });

      server.on('connection', () => {
        connectionsCount++;
      });

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      serverPort = (server.address() as any).port;
    });

    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('keep-alive reuse: origin sees fewer connections than sequential requests', async () => {
      connectionsCount = 0;
      const client = new UpstreamClient({ keepAlive: true, maxFreeSockets: 10 });

      const makeReq = () =>
        new Promise<number>((resolve, reject) => {
          client.request(
            {
              method: 'GET',
              url: new URL(`http://127.0.0.1:${serverPort}/test`),
              headers: { host: `127.0.0.1:${serverPort}` },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve(res.statusCode ?? 0));
            },
            reject
          );
        });

      // Send 5 sequential requests
      for (let i = 0; i < 5; i++) {
        const status = await makeReq();
        expect(status).toBe(200);
      }

      client.destroy();
      // With keep-alive, 5 requests should reuse the single connection
      expect(connectionsCount).toBeLessThan(5);
      expect(connectionsCount).toBe(1);
    });

    it('maxSockets queues requests without overloading', async () => {
      let activeConnections = 0;
      let maxActiveObserved = 0;

      const slowServer = http.createServer((req, res) => {
        activeConnections++;
        maxActiveObserved = Math.max(maxActiveObserved, activeConnections);
        setTimeout(() => {
          activeConnections--;
          res.writeHead(200);
          res.end('done');
        }, 50);
      });

      await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', () => r()));
      const slowPort = (slowServer.address() as any).port;

      const client = new UpstreamClient({ maxSockets: 2 });

      const makeReq = () =>
        new Promise<void>((resolve, reject) => {
          client.request(
            {
              method: 'GET',
              url: new URL(`http://127.0.0.1:${slowPort}/slow`),
              headers: { host: `127.0.0.1:${slowPort}` },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve());
            },
            reject
          );
        });

      // Send 6 concurrent requests
      await Promise.all([
        makeReq(),
        makeReq(),
        makeReq(),
        makeReq(),
        makeReq(),
        makeReq(),
      ]);

      client.destroy();
      await new Promise<void>((r) => slowServer.close(() => r()));

      // Observed concurrent connections must never exceed maxSockets (2)
      expect(maxActiveObserved).toBeLessThanOrEqual(2);
    });
  });

  describe('Integration tests: HTTPS verification and CA trust', () => {
    let httpsServer: https.Server;
    let httpsPort: number;
    let selfSignedCert: string;

    beforeAll(async () => {
      const pems: any = await (selfsigned as any).generate(
        [{ name: 'commonName', value: '127.0.0.1' }],
        {
          days: 1,
          extensions: [
            {
              name: 'subjectAltName',
              altNames: [
                { type: 7, ip: '127.0.0.1' },
                { type: 2, value: 'localhost' },
              ],
            },
          ],
        }
      );
      selfSignedCert = pems.cert;

      httpsServer = https.createServer(
        { key: pems.private, cert: pems.cert },
        (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('secure ok');
        }
      );

      await new Promise<void>((r) => httpsServer.listen(0, '127.0.0.1', () => r()));
      httpsPort = (httpsServer.address() as any).port;
    });

    afterAll(async () => {
      await new Promise<void>((r) => httpsServer.close(() => r()));
    });

    it('rejects untrusted self-signed certificate by default (rejectUnauthorized true)', async () => {
      const client = new UpstreamClient({ rejectUnauthorized: true });

      const error = await new Promise<any>((resolve) => {
        client.request(
          {
            method: 'GET',
            url: new URL(`https://127.0.0.1:${httpsPort}/check`),
            headers: { host: `127.0.0.1:${httpsPort}` },
          },
          () => {},
          (err) => resolve(err)
        );
      });

      client.destroy();
      expect(error).toBeDefined();
      expect(error.code).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    });

    it('succeeds with self-signed certificate when injected CA is trusted', async () => {
      const client = new UpstreamClient({
        ca: selfSignedCert,
        rejectUnauthorized: true,
      });

      const statusCode = await new Promise<number>((resolve, reject) => {
        client.request(
          {
            method: 'GET',
            url: new URL(`https://127.0.0.1:${httpsPort}/check`),
            headers: { host: `127.0.0.1:${httpsPort}` },
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
          reject
        );
      });

      client.destroy();
      expect(statusCode).toBe(200);
    });
  });

  describe('Integration tests: Stale socket retry race', () => {
    it('retries on stale socket closed by origin (/close-after-response)', async () => {
      let connectionsMade = 0;

      // Raw TCP server that serves HTTP response with keep-alive, then closes socket after 30ms
      const rawServer = net.createServer((socket) => {
        connectionsMade++;
        socket.on('data', () => {
          const resp =
            'HTTP/1.1 200 OK\r\n' +
            'Content-Type: text/plain\r\n' +
            'Content-Length: 4\r\n' +
            'Connection: keep-alive\r\n\r\n' +
            'ping';
          socket.write(resp);

          // Close socket shortly after responding to simulate keep-alive race
          setTimeout(() => {
            socket.destroy();
          }, 30);
        });
      });

      await new Promise<void>((r) => rawServer.listen(0, '127.0.0.1', () => r()));
      const rawPort = (rawServer.address() as any).port;

      const client = new UpstreamClient({ keepAlive: true });

      const makeReq = () =>
        new Promise<string>((resolve, reject) => {
          client.request(
            {
              method: 'GET',
              url: new URL(`http://127.0.0.1:${rawPort}/stale-race`),
              headers: { host: `127.0.0.1:${rawPort}` },
            },
            (res) => {
              let body = '';
              res.on('data', (d) => (body += d.toString()));
              res.on('end', () => resolve(body));
            },
            reject
          );
        });

      // First request succeeds and leaves socket in agent pool
      const body1 = await makeReq();
      expect(body1).toBe('ping');

      // Wait 35ms so server destroys the socket right around when request 2 arrives
      await new Promise((r) => setTimeout(r, 35));

      // Second request will either hit stale socket and auto-retry, or use fresh connection
      const body2 = await makeReq();
      expect(body2).toBe('ping');

      client.destroy();
      await new Promise<void>((r) => rawServer.close(() => r()));

      // Must have made at least 2 connections
      expect(connectionsMade).toBeGreaterThanOrEqual(2);
    });
  });
});
