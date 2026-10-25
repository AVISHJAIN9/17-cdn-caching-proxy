import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { rawRequest } from './helpers/raw-request.js';
import { UpstreamClient } from '../src/proxy/upstream.js';
import { shouldKeepAlive, shouldSendConnectionClose } from '../src/proxy/keepalive.js';

describe('Feature 5: Keep-alive (src/proxy/keepalive.ts)', () => {
  describe('Unit tests: shouldKeepAlive and shouldSendConnectionClose', () => {
    it('handles HTTP/1.1 default persistent and Connection: close', () => {
      const reqHttp11Default = { httpVersion: '1.1', headers: {} } as any;
      expect(shouldKeepAlive(reqHttp11Default)).toBe(true);
      expect(shouldSendConnectionClose(reqHttp11Default)).toBe(false);

      const reqHttp11Close = { httpVersion: '1.1', headers: { connection: 'close' } } as any;
      expect(shouldKeepAlive(reqHttp11Close)).toBe(false);
      expect(shouldSendConnectionClose(reqHttp11Close)).toBe(true);
    });

    it('handles HTTP/1.0 default close and Connection: keep-alive', () => {
      const reqHttp10Default = { httpVersion: '1.0', headers: {} } as any;
      expect(shouldKeepAlive(reqHttp10Default)).toBe(false);
      expect(shouldSendConnectionClose(reqHttp10Default)).toBe(true);

      const reqHttp10KeepAlive = { httpVersion: '1.0', headers: { connection: 'keep-alive' } } as any;
      expect(shouldKeepAlive(reqHttp10KeepAlive)).toBe(true);
      expect(shouldSendConnectionClose(reqHttp10KeepAlive)).toBe(false);
    });

    it('flags close on shutdown or maxRequestsPerSocket limit reached', () => {
      const req = { httpVersion: '1.1', headers: {} } as any;
      expect(shouldSendConnectionClose(req, { isShuttingDown: true })).toBe(true);
      expect(
        shouldSendConnectionClose(req, {
          requestsOnSocket: 3,
          maxRequestsPerSocket: 3,
        })
      ).toBe(true);
      expect(
        shouldSendConnectionClose(req, {
          requestsOnSocket: 2,
          maxRequestsPerSocket: 3,
        })
      ).toBe(false);
    });
  });

  describe('Integration tests: Client keep-alive and connection management', () => {
    let originServer: http.Server;
    let originPort: number;
    let defaultProxy: any;
    let defaultProxyPort: number;

    beforeAll(async () => {
      originServer = http.createServer((req, res) => {
        if (req.url === '/slow') {
          setTimeout(() => {
            res.writeHead(200, {
              'Content-Type': 'text/plain',
              'Content-Length': '4',
            });
            res.end('slow');
          }, 250);
          return;
        }

        if (req.url === '/close-from-origin') {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Length': '17',
            Connection: 'close',
          });
          res.end('close-from-origin');
          return;
        }

        const body = `echo:${req.url}`;
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      });

      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => resolve());
      });
      originPort = (originServer.address() as net.AddressInfo).port;

      defaultProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      defaultProxyPort = defaultProxy.httpPort!;
    });

    afterAll(async () => {
      await defaultProxy.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('two sequential requests on one connection share a socket', async () => {
      const socket = new net.Socket();
      await new Promise<void>((resolve) => socket.connect(defaultProxyPort, '127.0.0.1', () => resolve()));

      // 1. Send first request
      socket.write('GET /seq-1 HTTP/1.1\r\nHost: localhost\r\n\r\n');

      const readUntil = async (predicate: (data: string) => boolean): Promise<string> => {
        let buffer = '';
        return new Promise<string>((resolve) => {
          const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            if (predicate(buffer)) {
              socket.off('data', onData);
              resolve(buffer);
            }
          };
          socket.on('data', onData);
        });
      };

      const res1 = await readUntil((d) => d.includes('echo:/seq-1'));
      expect(res1).toContain('HTTP/1.1 200 OK');
      expect(socket.destroyed).toBe(false);

      // 2. Send second request on the same socket
      socket.write('GET /seq-2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      const res2 = await readUntil((d) => d.includes('echo:/seq-2'));
      expect(res2).toContain('HTTP/1.1 200 OK');

      // Since second request sent Connection: close, socket closes
      await new Promise<void>((resolve) => socket.on('close', () => resolve()));
      expect(socket.destroyed).toBe(true);
    });

    it('client Connection: close closes the socket and returns Connection: close', async () => {
      const res = await rawRequest(
        defaultProxyPort,
        'GET /close-header HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['connection']).toBe('close');
      expect(res.socketClosed).toBe(true);
    });

    it('HTTP/1.0 without keep-alive closes by default', async () => {
      const res = await rawRequest(
        defaultProxyPort,
        'GET /http10-default HTTP/1.0\r\nHost: localhost\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['connection']).toBe('close');
      expect(res.socketClosed).toBe(true);
    });

    it('HTTP/1.0 with Connection: keep-alive keeps socket alive', async () => {
      const socket = new net.Socket();
      await new Promise<void>((resolve) => socket.connect(defaultProxyPort, '127.0.0.1', () => resolve()));

      socket.write('GET /http10-ka HTTP/1.0\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');

      let data = '';
      await new Promise<void>((resolve) => {
        socket.on('data', (c) => {
          data += c.toString();
          if (data.includes('echo:/http10-ka')) {
            resolve();
          }
        });
      });

      expect(data).toContain('HTTP/1.1 200 OK');
      expect(data.toLowerCase()).toContain('connection: keep-alive');
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    });

    it('maxRequestsPerSocket=3 makes the 3rd response carry Connection: close and closes socket', async () => {
      const customProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        server: {
          maxRequestsPerSocket: 3,
        },
      });
      const customPort = customProxy.httpPort!;

      try {
        const socket = new net.Socket();
        await new Promise<void>((resolve) => socket.connect(customPort, '127.0.0.1', () => resolve()));

        const readResponse = async (): Promise<string> => {
          let buf = '';
          return new Promise<string>((resolve) => {
            const onData = (c: Buffer) => {
              buf += c.toString('utf-8');
              if (buf.includes('\r\n\r\n') && (buf.includes('echo:') || buf.includes('Content-Length: 0'))) {
                socket.off('data', onData);
                resolve(buf);
              }
            };
            socket.on('data', onData);
          });
        };

        // Req 1
        socket.write('GET /req-1 HTTP/1.1\r\nHost: localhost\r\n\r\n');
        const r1 = await readResponse();
        expect(r1).toContain('HTTP/1.1 200 OK');
        expect(r1.toLowerCase()).not.toContain('connection: close');
        expect(socket.destroyed).toBe(false);

        // Req 2
        socket.write('GET /req-2 HTTP/1.1\r\nHost: localhost\r\n\r\n');
        const r2 = await readResponse();
        expect(r2).toContain('HTTP/1.1 200 OK');
        expect(r2.toLowerCase()).not.toContain('connection: close');
        expect(socket.destroyed).toBe(false);

        // Req 3 (3rd and last allowed request)
        socket.write('GET /req-3 HTTP/1.1\r\nHost: localhost\r\n\r\n');
        const r3 = await readResponse();
        expect(r3).toContain('HTTP/1.1 200 OK');
        expect(r3.toLowerCase()).toContain('connection: close');

        // Socket should now be closed by server
        await new Promise<void>((resolve) => socket.on('close', () => resolve()));
        expect(socket.destroyed).toBe(true);

        // 4th request requires a new connection
        const r4 = await rawRequest(customPort, 'GET /req-4 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        expect(r4.statusCode).toBe(200);
      } finally {
        await customProxy.stop();
      }
    });

    it('idle socket is closed after keepAliveTimeoutMs', async () => {
      const idleProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        timeouts: {
          keepAliveTimeoutMs: 150,
        },
      });
      const idlePort = idleProxy.httpPort!;

      try {
        const socket = new net.Socket();
        await new Promise<void>((resolve) => socket.connect(idlePort, '127.0.0.1', () => resolve()));

        // Send a request and wait for response
        socket.write('GET /idle HTTP/1.1\r\nHost: localhost\r\n\r\n');
        let received = '';
        await new Promise<void>((resolve) => {
          socket.on('data', (c) => {
            received += c.toString();
            if (received.includes('echo:/idle')) resolve();
          });
        });

        // Now stay idle without sending data; socket should close in ~150-350ms
        const start = Date.now();
        await new Promise<void>((resolve) => socket.on('close', () => resolve()));
        const duration = Date.now() - start;

        expect(socket.destroyed).toBe(true);
        expect(duration).toBeGreaterThanOrEqual(100);
        expect(duration).toBeLessThan(2000);
      } finally {
        await idleProxy.stop();
      }
    });

    it('two pipelined requests written back to back on one raw socket come back complete and in order', async () => {
      const res = await rawRequest(
        defaultProxyPort,
        'GET /pipe-1 HTTP/1.1\r\nHost: localhost\r\n\r\n' +
          'GET /pipe-2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.raw.toString()).toContain('echo:/pipe-1');
      expect(res.raw.toString()).toContain('echo:/pipe-2');

      const index1 = res.raw.toString().indexOf('echo:/pipe-1');
      const index2 = res.raw.toString().indexOf('echo:/pipe-2');
      expect(index1).toBeGreaterThan(-1);
      expect(index2).toBeGreaterThan(index1);
      expect(res.socketClosed).toBe(true);
    });

    it('during shutdown idle sockets close immediately while an in-flight request still completes', async () => {
      const shutdownProxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const shutPort = shutdownProxy.httpPort!;

      // 1. Idle socket: send a fast request and remain idle
      const idleSocket = new net.Socket();
      await new Promise<void>((resolve) => idleSocket.connect(shutPort, '127.0.0.1', () => resolve()));
      idleSocket.write('GET /fast HTTP/1.1\r\nHost: localhost\r\n\r\n');
      let idleData = '';
      await new Promise<void>((resolve) => {
        idleSocket.on('data', (c) => {
          idleData += c.toString();
          if (idleData.includes('echo:/fast')) resolve();
        });
      });
      expect(idleSocket.destroyed).toBe(false);

      // 2. In-flight socket: send a slow request (/slow takes 250ms)
      const inFlightSocket = new net.Socket();
      await new Promise<void>((resolve) => inFlightSocket.connect(shutPort, '127.0.0.1', () => resolve()));
      inFlightSocket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');

      // Wait 30ms to ensure the slow request was dispatched to origin
      await new Promise((r) => setTimeout(r, 30));

      // Trigger shutdown now!
      const stopPromise = shutdownProxy.stop();

      // Idle socket must close immediately upon shutdown!
      await new Promise<void>((resolve) => idleSocket.on('close', () => resolve()));
      expect(idleSocket.destroyed).toBe(true);

      // In-flight socket should still receive its full response
      let inFlightData = '';
      await new Promise<void>((resolve) => {
        inFlightSocket.on('data', (c) => {
          inFlightData += c.toString();
        });
        inFlightSocket.on('close', () => resolve());
      });

      expect(inFlightData).toContain('HTTP/1.1 200 OK');
      expect(inFlightData).toContain('slow');
      expect(inFlightData.toLowerCase()).toContain('connection: close');

      await stopPromise;
    });

    it('upstream side: Connection: close response from origin is not reused by the agent, while keep-alive works otherwise', async () => {
      const client = new UpstreamClient({ keepAlive: true });

      try {
        let firstSocket: net.Socket | undefined;
        let secondSocket: net.Socket | undefined;

        // 1. Normal keep-alive requests share socket
        const req1 = client.request(
          {
            url: new URL(`http://127.0.0.1:${originPort}/ka-1`),
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => res.resume(),
          () => {}
        );
        req1.on('socket', (s) => {
          firstSocket = s;
        });

        await new Promise((r) => setTimeout(r, 60));

        const req2 = client.request(
          {
            url: new URL(`http://127.0.0.1:${originPort}/ka-2`),
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => res.resume(),
          () => {}
        );
        req2.on('socket', (s) => {
          secondSocket = s;
        });

        await new Promise((r) => setTimeout(r, 60));
        expect(firstSocket).toBeDefined();
        expect(secondSocket).toBeDefined();
        expect(secondSocket).toBe(firstSocket); // Reused!

        // 2. Request that receives Connection: close from origin
        let closeSocket: net.Socket | undefined;
        const reqClose = client.request(
          {
            url: new URL(`http://127.0.0.1:${originPort}/close-from-origin`),
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => res.resume(),
          () => {}
        );
        reqClose.on('socket', (s) => {
          closeSocket = s;
        });

        await new Promise((r) => setTimeout(r, 60));

        // 3. Subsequent request must NOT reuse closeSocket
        let afterCloseSocket: net.Socket | undefined;
        const reqAfterClose = client.request(
          {
            url: new URL(`http://127.0.0.1:${originPort}/ka-3`),
            method: 'GET',
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => res.resume(),
          () => {}
        );
        reqAfterClose.on('socket', (s) => {
          afterCloseSocket = s;
        });

        await new Promise((r) => setTimeout(r, 60));
        expect(afterCloseSocket).toBeDefined();
        expect(afterCloseSocket).not.toBe(closeSocket); // Brand new socket!
      } finally {
        client.destroy();
      }
    });
  });
});
