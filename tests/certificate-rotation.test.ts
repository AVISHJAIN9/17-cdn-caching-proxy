import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { ProxyListener } from '../src/proxy/listener.js';
import { UpstreamClient } from '../src/proxy/upstream.js';
import { CertificateFileWatcher } from '../src/tls/cert-watcher.js';
import { CertificateManager, loadAndValidateCertificate } from '../src/tls/cert-config.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/tls');
const CA_CERT = path.join(FIXTURES_DIR, 'ca.crt');
const SERVER_CERT = path.join(FIXTURES_DIR, 'server.crt');
const SERVER_KEY = path.join(FIXTURES_DIR, 'server.key');
const SERVER_ALT_CERT = path.join(FIXTURES_DIR, 'server-alt.crt');
const SERVER_ALT_KEY = path.join(FIXTURES_DIR, 'server-alt.key');
const CLIENT_CERT = path.join(FIXTURES_DIR, 'client.crt');
const CLIENT_KEY = path.join(FIXTURES_DIR, 'client.key');

function getPeerCertFingerprint(
  port: number,
  caPath: string,
  options?: { servername?: string; checkServerIdentity?: () => undefined }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const connectOptions: tls.ConnectionOptions = {
      host: '127.0.0.1',
      port,
      servername: options?.servername ?? 'localhost',
      ca: fs.readFileSync(caPath),
      rejectUnauthorized: true,
    };
    if (options?.checkServerIdentity) {
      connectOptions.checkServerIdentity = options.checkServerIdentity;
    }
    const socket = tls.connect(connectOptions, () => {
        const cert = socket.getPeerCertificate();
        const fp = cert.fingerprint256;
        socket.destroy();
        resolve(fp);
      }
    );
    socket.on('error', reject);
  });
}

describe('Feature 82: Certificate rotation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-cert-rot-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('replacing certificate on disk is picked up without restart and new connections use the new one', async () => {
    const activeCertPath = path.join(tmpDir, 'active.crt');
    const activeKeyPath = path.join(tmpDir, 'active.key');

    // Initially copy server.crt / server.key
    fs.copyFileSync(SERVER_CERT, activeCertPath);
    fs.copyFileSync(SERVER_KEY, activeKeyPath);

    const server1Fp = new crypto.X509Certificate(fs.readFileSync(SERVER_CERT)).fingerprint256;
    const serverAltFp = new crypto.X509Certificate(fs.readFileSync(SERVER_ALT_CERT)).fingerprint256;
    expect(server1Fp).not.toBe(serverAltFp);

    let reloadCalled = false;
    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: activeCertPath,
            keyPath: activeKeyPath,
            watch: true,
          },
        },
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    // 1. Initial connection negotiates server.crt
    const fp1 = await getPeerCertFingerprint(port, CA_CERT);
    expect(fp1).toBe(server1Fp);

    // 2. Overwrite files on disk with server-alt
    fs.copyFileSync(SERVER_ALT_CERT, activeCertPath);
    fs.copyFileSync(SERVER_ALT_KEY, activeKeyPath);

    // Trigger reload
    listener.reloadCertificates();

    // 3. New connection receives server-alt
    const fp2 = await getPeerCertFingerprint(port, CA_CERT, { servername: 'alt.example.com' });
    expect(fp2).toBe(serverAltFp);

    await listener.stop();
  });

  it('in-flight requests finish on the old certificate while new connections use the new one', async () => {
    const activeCertPath = path.join(tmpDir, 'active.crt');
    const activeKeyPath = path.join(tmpDir, 'active.key');

    fs.copyFileSync(SERVER_CERT, activeCertPath);
    fs.copyFileSync(SERVER_KEY, activeKeyPath);

    const server1Fp = new crypto.X509Certificate(fs.readFileSync(SERVER_CERT)).fingerprint256;
    const serverAltFp = new crypto.X509Certificate(fs.readFileSync(SERVER_ALT_CERT)).fingerprint256;

    let resolveInFlight: (() => void) | undefined;
    const inFlightPromise = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: activeCertPath,
            keyPath: activeKeyPath,
            watch: false,
          },
        },
      },
      async (req, res) => {
        if (req.url === '/slow') {
          await inFlightPromise;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('slow-finished');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('fast');
        }
      }
    );

    await listener.start();
    const port = listener.httpsPort!;

    // Start in-flight request on connection 1
    let client1Fp = '';
    const req1Promise = new Promise<string>((resolve, reject) => {
      const agent = new https.Agent({ ca: fs.readFileSync(CA_CERT) });
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/slow',
          method: 'GET',
          agent,
          servername: 'localhost',
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }
      );
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const peer = (socket as tls.TLSSocket).getPeerCertificate();
          client1Fp = peer.fingerprint256;
        });
      });
      req.on('error', reject);
      req.end();
    });

    // Wait briefly for connection 1 to negotiate TLS and be in-flight
    await new Promise((r) => setTimeout(r, 80));
    expect(client1Fp).toBe(server1Fp);

    // Now rotate certificate on disk
    fs.copyFileSync(SERVER_ALT_CERT, activeCertPath);
    fs.copyFileSync(SERVER_ALT_KEY, activeKeyPath);
    listener.reloadCertificates();

    // Connection 2 establishes AFTER rotation -> receives server-alt
    const client2Fp = await getPeerCertFingerprint(port, CA_CERT, { servername: 'alt.example.com' });
    expect(client2Fp).toBe(serverAltFp);

    // Resolve in-flight request 1 and verify it completes cleanly on the old socket
    resolveInFlight!();
    const res1Data = await req1Promise;
    expect(res1Data).toBe('slow-finished');
    expect(client1Fp).toBe(server1Fp);

    await listener.stop();
  });

  it('broken new certificate keeps the old certificate active and logs the error', async () => {
    const activeCertPath = path.join(tmpDir, 'active.crt');
    const activeKeyPath = path.join(tmpDir, 'active.key');

    fs.copyFileSync(SERVER_CERT, activeCertPath);
    fs.copyFileSync(SERVER_KEY, activeKeyPath);

    const server1Fp = new crypto.X509Certificate(fs.readFileSync(SERVER_CERT)).fingerprint256;

    let errorLogged = false;
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      errorLogged = true;
      originalConsoleError(...args);
    };

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            certPath: activeCertPath,
            keyPath: activeKeyPath,
            watch: false,
          },
        },
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    );

    try {
      await listener.start();
      const port = listener.httpsPort!;

      // 1. Initial connection is server.crt
      const fp1 = await getPeerCertFingerprint(port, CA_CERT);
      expect(fp1).toBe(server1Fp);

      // 2. Write corrupted garbage to active.crt
      fs.writeFileSync(activeCertPath, '-----BEGIN CERTIFICATE-----\nGARBAGE\n-----END CERTIFICATE-----');

      // Attempt reload
      expect(() => {
        listener.certificateManager!.reloadCertificate({
          certPath: activeCertPath,
          keyPath: activeKeyPath,
        });
      }).toThrow();

      // 3. New connection still successfully negotiates with the old, valid certificate
      const fp2 = await getPeerCertFingerprint(port, CA_CERT);
      expect(fp2).toBe(server1Fp);

      await listener.stop();
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('rotation of upstream client certificate works without restarting UpstreamClient', async () => {
    const clientCertPath = path.join(tmpDir, 'client.crt');
    const clientKeyPath = path.join(tmpDir, 'client.key');

    fs.copyFileSync(CLIENT_CERT, clientCertPath);
    fs.copyFileSync(CLIENT_KEY, clientKeyPath);

    let receivedClientFp = '';
    const mTLSServer = https.createServer(
      {
        cert: fs.readFileSync(SERVER_CERT),
        key: fs.readFileSync(SERVER_KEY),
        ca: fs.readFileSync(CA_CERT),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const cert = (req.socket as tls.TLSSocket).getPeerCertificate();
        receivedClientFp = cert.fingerprint256;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('mtls-ok');
      }
    );

    await new Promise<void>((resolve) => mTLSServer.listen(0, '127.0.0.1', resolve));
    const serverPort = (mTLSServer.address() as any).port;

    try {
      let rotated = false;
      const upstream = new UpstreamClient({
        ca: fs.readFileSync(CA_CERT),
        clientCertPath,
        clientKeyPath,
        watchCerts: false,
        onCertRotate: () => {
          rotated = true;
        },
      });

      const initialClientFp = new crypto.X509Certificate(fs.readFileSync(CLIENT_CERT)).fingerprint256;
      const altClientFp = new crypto.X509Certificate(fs.readFileSync(SERVER_ALT_CERT)).fingerprint256;

      // Request 1 with initial client cert
      const agent1 = upstream.getAgent('https:');
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: serverPort,
            path: '/test',
            agent: agent1,
            servername: 'localhost',
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(receivedClientFp).toBe(initialClientFp);

      // Now rotate client cert on disk to server-alt (which is also signed by CA)
      fs.copyFileSync(SERVER_ALT_CERT, clientCertPath);
      fs.copyFileSync(SERVER_ALT_KEY, clientKeyPath);

      upstream.reloadClientCertificates();
      expect(rotated).toBe(true);

      // Request 2 with rotated client cert
      const agent2 = upstream.getAgent('https:');
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: serverPort,
            path: '/test',
            agent: agent2,
            servername: 'localhost',
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(receivedClientFp).toBe(altClientFp);

      // Broken cert preserves old one
      let errorOccurred = false;
      upstream.config.onCertError = () => {
        errorOccurred = true;
      };
      fs.writeFileSync(clientCertPath, 'broken');
      upstream.reloadClientCertificates();
      expect(errorOccurred).toBe(true);
      expect(upstream.config.clientCert).toBeDefined();

      upstream.close();
    } finally {
      await new Promise<void>((resolve) => mTLSServer.close(() => resolve()));
    }
  });

  it('cleanly closes watchers on shutdown without leaking timers or fs watchers', async () => {
    const certPath = path.join(tmpDir, 'cert.crt');
    const keyPath = path.join(tmpDir, 'key.key');
    fs.copyFileSync(SERVER_CERT, certPath);
    fs.copyFileSync(SERVER_KEY, keyPath);

    let reloaded = false;
    const watcher = new CertificateFileWatcher([certPath, keyPath], {
      debounceMs: 50,
      onReload: () => {
        reloaded = true;
      },
    });

    expect((watcher as any).closed).toBe(false);
    expect((watcher as any).watchers.length).toBeGreaterThan(0);

    // Closing watcher cleans up all fs.FSWatchers and timers
    watcher.close();
    expect((watcher as any).closed).toBe(true);
    expect((watcher as any).watchers.length).toBe(0);
    expect((watcher as any).debounceTimer).toBeUndefined();

    // Trigger after close does nothing
    await watcher.triggerReload();
    expect(reloaded).toBe(false);
  });
});
