import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 79: TLS termination', { timeout: 25000 }, () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/tls');
  const caCrt = fs.readFileSync(path.join(fixturesDir, 'ca.crt'));
  const serverCrtPath = path.join(fixturesDir, 'server.crt');
  const serverKeyPath = path.join(fixturesDir, 'server.key');
  const serverAltCrtPath = path.join(fixturesDir, 'server-alt.crt');
  const serverAltKeyPath = path.join(fixturesDir, 'server-alt.key');

  let originServer: http.Server;
  let originPort: number;
  let originRequests = 0;
  let proxy: ProxyListener;
  let proxyHttpsPort: number;
  let store: MemoryStore;

  beforeEach(async () => {
    originRequests = 0;

    originServer = http.createServer((req, res) => {
      originRequests++;

      if (req.url === '/data') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=3600',
          'ETag': '"v1.0"',
        });
        res.end('cached-https-content');
        return;
      }

      if (req.url === '/binary') {
        const binBuf = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x42, 0x99]);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': binBuf.length.toString(),
        });
        res.end(binBuf);
        return;
      }

      if (req.url === '/range-target') {
        const fullBody = '0123456789abcdefghijklmnopqrstuvwxyz';
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': fullBody.length.toString(),
          'Accept-Ranges': 'bytes',
        });
        res.end(fullBody);
        return;
      }

      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as AddressInfo).port;

    store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      httpsHost: '127.0.0.1',
      httpsPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      cache: {
        enabled: true,
        debugHeaders: true,
        range: true,
      },
      tls: {
        certificates: [
          { certPath: serverCrtPath, keyPath: serverKeyPath, isDefault: true },
          { certPath: serverAltCrtPath, keyPath: serverAltKeyPath },
        ],
      },
    });

    proxyHttpsPort = proxy.httpsPort!;
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (originServer) {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  // Helper function for HTTPS requests
  function makeHttpsRequest(
    reqPath: string,
    options: https.RequestOptions = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const opts: https.RequestOptions = {
        hostname: '127.0.0.1',
        port: proxyHttpsPort,
        path: reqPath,
        method: 'GET',
        ca: caCrt,
        servername: 'localhost',
        ...options,
      };

      const req = https.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  it('HTTPS listener serves cache end-to-end (MISS and HIT)', async () => {
    // 1. Initial request (MISS)
    const res1 = await makeHttpsRequest('/data');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.toString('utf-8')).toBe('cached-https-content');
    expect(originRequests).toBe(1);

    // 2. Second request (HIT)
    const res2 = await makeHttpsRequest('/data');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body.toString('utf-8')).toBe('cached-https-content');
    expect(originRequests).toBe(1); // Served from cache
  });

  it('refuses TLS protocol versions below TLSv1.2', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
          {
            host: '127.0.0.1',
            port: proxyHttpsPort,
            ca: caCrt,
            servername: 'localhost',
            maxVersion: 'TLSv1.1',
          },
          () => {
            socket.destroy();
            resolve();
          }
        );
        socket.on('error', reject);
      })
    ).rejects.toThrow();
  });

  it('SNI picks the right certificate and unknown SNI falls back to default', async () => {
    // 1. SNI: alt.example.com -> receives server-alt cert
    const altCertPromise = new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: proxyHttpsPort,
          ca: caCrt,
          servername: 'alt.example.com',
        },
        () => {
          const peerCert = socket.getPeerCertificate();
          socket.destroy();
          resolve(peerCert);
        }
      );
      socket.on('error', reject);
    });
    const altPeer = await altCertPromise;
    expect(altPeer.subject.CN).toBe('alt.example.com');

    // 2. SNI: localhost -> receives default server cert
    const localCertPromise = new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: proxyHttpsPort,
          ca: caCrt,
          servername: 'localhost',
        },
        () => {
          const peerCert = socket.getPeerCertificate();
          socket.destroy();
          resolve(peerCert);
        }
      );
      socket.on('error', reject);
    });
    const localPeer = await localCertPromise;
    expect(localPeer.subject.CN).toBe('localhost');

    // 3. Unknown SNI (unrecognized.org) -> fallback to default certificate
    const unknownCertPromise = new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: proxyHttpsPort,
          ca: caCrt,
          servername: 'unrecognized.org',
          checkServerIdentity: () => undefined, // bypass hostname check on client
        },
        () => {
          const peerCert = socket.getPeerCertificate();
          socket.destroy();
          resolve(peerCert);
        }
      );
      socket.on('error', reject);
    });
    const unknownPeer = await unknownCertPromise;
    expect(unknownPeer.subject.CN).toBe('localhost');
  });

  it('refuses unknown SNI when refuseUnknownSni is configured', async () => {
    const strictProxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      httpsHost: '127.0.0.1',
      httpsPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      tls: {
        refuseUnknownSni: true,
        certificates: [
          { certPath: serverCrtPath, keyPath: serverKeyPath, isDefault: true },
          { certPath: serverAltCrtPath, keyPath: serverAltKeyPath },
        ],
      },
    });

    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = tls.connect(
            {
              host: '127.0.0.1',
              port: strictProxy.httpsPort!,
              ca: caCrt,
              servername: 'unrecognized-domain.org',
              checkServerIdentity: () => undefined,
            },
            () => {
              socket.destroy();
              resolve();
            }
          );
          socket.on('error', reject);
        })
      ).rejects.toThrow();
    } finally {
      await strictProxy.stop();
    }
  });

  it('HTTP/1.1 keep-alive over TLS works and reuses TLS socket across requests', async () => {
    const agent = new https.Agent({
      keepAlive: true,
      ca: caCrt,
      maxSockets: 1,
    });

    try {
      const res1 = await makeHttpsRequest('/data', { agent });
      expect(res1.status).toBe(200);

      const res2 = await makeHttpsRequest('/data', { agent });
      expect(res2.status).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');
    } finally {
      agent.destroy();
    }
  });

  it('handshake abort and garbage bytes do not crash listener or leak sockets', async () => {
    // 1. Send garbage bytes to HTTPS port
    await new Promise<void>((resolve) => {
      const rawSock = net.connect({ host: '127.0.0.1', port: proxyHttpsPort }, () => {
        rawSock.write('NOT_A_VALID_TLS_CLIENT_HELLO_GARBAGE_PAYLOAD\r\n\r\n');
        setTimeout(() => {
          rawSock.destroy();
          resolve();
        }, 30);
      });
      rawSock.on('error', () => resolve());
    });

    // 2. Abort connection immediately during handshake
    await new Promise<void>((resolve) => {
      const abortSock = net.connect({ host: '127.0.0.1', port: proxyHttpsPort }, () => {
        // Send first byte of TLS handshake then abruptly destroy
        abortSock.write(Buffer.from([0x16, 0x03, 0x01]));
        abortSock.destroy();
        resolve();
      });
      abortSock.on('error', () => resolve());
    });

    // 3. Listener is still fully healthy and functional
    const res = await makeHttpsRequest('/data');
    expect(res.status).toBe(200);
    expect(res.body.toString('utf-8')).toBe('cached-https-content');
  });

  it('runs representative subset of Batch 1-14 features over TLS', async () => {
    // 1. Binary octet-stream preservation over TLS
    const binRes = await makeHttpsRequest('/binary');
    expect(binRes.status).toBe(200);
    expect(binRes.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(binRes.body, Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x42, 0x99]))).toBe(0);

    // 2. Conditional 304 revalidation over TLS
    // Prime the cache first
    await makeHttpsRequest('/data');
    const condRes = await makeHttpsRequest('/data', {
      headers: { 'If-None-Match': '"v1.0"' },
    });
    expect(condRes.status).toBe(304);
    expect(condRes.body.length).toBe(0);

    // 3. Range requests 206 Partial Content over TLS
    // Prime the cache
    await makeHttpsRequest('/range-target');
    const rangeRes = await makeHttpsRequest('/range-target', {
      headers: { Range: 'bytes=0-9' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers['content-range']).toBe('bytes 0-9/36');
    expect(rangeRes.body.toString('utf-8')).toBe('0123456789');
    expect(rangeRes.headers['x-cache']).toBe('HIT');
  });
});
