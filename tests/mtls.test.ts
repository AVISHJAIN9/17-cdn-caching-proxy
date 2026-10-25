import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import crypto from 'node:crypto';
import { ProxyListener } from '../src/proxy/listener.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { UpstreamClient } from '../src/proxy/upstream.js';
import type { RequestContext } from '../src/proxy/context.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/tls');
const CA_CERT = path.join(FIXTURES_DIR, 'ca.crt');
const SERVER_CERT = path.join(FIXTURES_DIR, 'server.crt');
const SERVER_KEY = path.join(FIXTURES_DIR, 'server.key');
const CLIENT_CERT = path.join(FIXTURES_DIR, 'client.crt');
const CLIENT_KEY = path.join(FIXTURES_DIR, 'client.key');
const EXPIRED_CERT = path.join(FIXTURES_DIR, 'expired.crt');
const EXPIRED_KEY = path.join(FIXTURES_DIR, 'expired.key');
const UNTRUSTED_CERT = path.join(FIXTURES_DIR, 'untrusted-server.crt');
const UNTRUSTED_KEY = path.join(FIXTURES_DIR, 'untrusted-server.key');

function makeHttpsRequest(
  port: number,
  options: {
    cert?: Buffer | string;
    key?: Buffer | string;
    ca?: Buffer | string;
    path?: string;
  } = {}
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path ?? '/test',
        method: 'GET',
        servername: 'localhost',
        ca: options.ca ?? fs.readFileSync(CA_CERT),
        cert: options.cert,
        key: options.key,
        rejectUnauthorized: true,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Feature 83: mTLS', () => {
  it('clientAuth: "required" - passes valid client cert and rejects no cert, untrusted CA, and expired cert', async () => {
    let capturedContext: RequestContext | undefined;

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: SERVER_CERT,
            keyPath: SERVER_KEY,
            clientAuth: 'required',
            clientCaPath: CA_CERT,
          },
        },
      },
      (req, res) => {
        // req.clientCert is populated by listener
        const ctx = {
          requestId: 'test-req',
          signal: new AbortController().signal,
          phase: 'receiving' as const,
          startedAt: Date.now(),
          clientCert: (req as any).clientCert,
          abort() {},
        };
        capturedContext = ctx;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clientCert: ctx.clientCert }));
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    try {
      // 1. Valid client certificate signed by CA passes
      const validRes = await makeHttpsRequest(port, {
        cert: fs.readFileSync(CLIENT_CERT),
        key: fs.readFileSync(CLIENT_KEY),
      });
      expect(validRes.status).toBe(200);
      const parsedBody = JSON.parse(validRes.body);
      expect(parsedBody.ok).toBe(true);

      // Verify client identity in request context
      expect(capturedContext?.clientCert).toBeDefined();
      expect(capturedContext?.clientCert?.authorized).toBe(true);
      expect(capturedContext?.clientCert?.fingerprint256).toBeDefined();
      expect(capturedContext?.clientCert?.subject).toBeDefined();

      const expectedFp = new crypto.X509Certificate(fs.readFileSync(CLIENT_CERT)).fingerprint256;
      expect(capturedContext?.clientCert?.fingerprint256).toBe(expectedFp);

      // 2. No client cert is rejected
      await expect(makeHttpsRequest(port, {})).rejects.toThrow();

      // 3. Untrusted CA cert is rejected
      await expect(
        makeHttpsRequest(port, {
          cert: fs.readFileSync(UNTRUSTED_CERT),
          key: fs.readFileSync(UNTRUSTED_KEY),
        })
      ).rejects.toThrow();

      // 4. Expired client cert is rejected
      await expect(
        makeHttpsRequest(port, {
          cert: fs.readFileSync(EXPIRED_CERT),
          key: fs.readFileSync(EXPIRED_KEY),
        })
      ).rejects.toThrow();
    } finally {
      await listener.stop();
    }
  });

  it('clientAuth: "optional" - allows connection without cert, and verifies cert when presented', async () => {
    let capturedClientCert: any = undefined;

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: SERVER_CERT,
            keyPath: SERVER_KEY,
            clientAuth: 'optional',
            clientCaPath: CA_CERT,
          },
        },
      },
      (req, res) => {
        capturedClientCert = (req as any).clientCert;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasCert: Boolean((req as any).clientCert) }));
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    try {
      // 1. Connection with valid client cert
      const withCert = await makeHttpsRequest(port, {
        cert: fs.readFileSync(CLIENT_CERT),
        key: fs.readFileSync(CLIENT_KEY),
      });
      expect(withCert.status).toBe(200);
      expect(capturedClientCert).toBeDefined();
      expect(capturedClientCert.authorized).toBe(true);

      // 2. Connection without client cert succeeds in optional mode
      capturedClientCert = undefined;
      const withoutCert = await makeHttpsRequest(port, {});
      expect(withoutCert.status).toBe(200);
      expect(capturedClientCert).toBeUndefined();
    } finally {
      await listener.stop();
    }
  });

  it('clientAuth: "off" - does not request client certificates', async () => {
    let capturedClientCert: any = undefined;

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: SERVER_CERT,
            keyPath: SERVER_KEY,
            clientAuth: 'off',
          },
        },
      },
      (req, res) => {
        capturedClientCert = (req as any).clientCert;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    try {
      const res = await makeHttpsRequest(port, {});
      expect(res.status).toBe(200);
      expect(capturedClientCert).toBeUndefined();
    } finally {
      await listener.stop();
    }
  });

  it('upstream mTLS presents configured client certificate to origin', async () => {
    let originReceivedClientCert: boolean = false;
    let originClientFingerprint: string = '';

    // Mock mTLS Origin server that requires client certificates signed by CA
    const originServer = https.createServer(
      {
        cert: fs.readFileSync(SERVER_CERT),
        key: fs.readFileSync(SERVER_KEY),
        ca: fs.readFileSync(CA_CERT),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const peer = (req.socket as tls.TLSSocket).getPeerCertificate();
        originReceivedClientCert = Boolean(peer && Object.keys(peer).length > 0);
        originClientFingerprint = peer?.fingerprint256 ?? '';
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('origin-mtls-verified');
      }
    );

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    const originPort = (originServer.address() as any).port;

    const expectedClientFp = new crypto.X509Certificate(fs.readFileSync(CLIENT_CERT)).fingerprint256;

    // Start Proxy configured with upstream client certificate
    const store = new MemoryStore({ maxObjectBytes: 5 * 1024 * 1024 });
    const proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `https://localhost:${originPort}`,
      store,
      upstream: {
        ca: fs.readFileSync(CA_CERT),
        clientCert: fs.readFileSync(CLIENT_CERT),
        clientKey: fs.readFileSync(CLIENT_KEY),
      },
    });

    const proxyPort = proxy.httpPort!;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('origin-mtls-verified');

      expect(originReceivedClientCert).toBe(true);
      expect(originClientFingerprint).toBe(expectedClientFp);
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  it('private key never appears in logs, errors, or context', async () => {
    const rawKey = fs.readFileSync(CLIENT_KEY, 'utf-8');
    const privateKeySnippet = rawKey.split('\n')[2].trim(); // distinctive private key payload

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: SERVER_CERT,
            keyPath: SERVER_KEY,
            clientAuth: 'required',
            clientCaPath: CA_CERT,
          },
        },
      },
      (req, res) => {
        const clientCert = (req as any).clientCert;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clientCert }));
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    try {
      const res = await makeHttpsRequest(port, {
        cert: fs.readFileSync(CLIENT_CERT),
        key: fs.readFileSync(CLIENT_KEY),
      });

      expect(res.status).toBe(200);
      expect(res.body).not.toContain(privateKeySnippet);
      expect(res.body).not.toContain('PRIVATE KEY');
    } finally {
      await listener.stop();
    }
  });
});
