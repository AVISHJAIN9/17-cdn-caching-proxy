import { describe, it, expect } from 'vitest';
import { ProxyListener } from '../src/proxy/listener.js';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import selfsigned from 'selfsigned';

function makeRequest(
  url: string,
  options: http.RequestOptions = {}
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const req = client.request(
      url,
      {
        rejectUnauthorized: false,
        ...options,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Feature 1: HTTP/HTTPS listener', () => {
  it('starts and stops cleanly on HTTP (port 0)', async () => {
    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
        },
        handleSignals: false,
      },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello http');
      }
    );

    await listener.start();
    const port = listener.httpPort;
    expect(port).toBeDefined();
    expect(port).toBeGreaterThan(0);

    const res = await makeRequest(`http://127.0.0.1:${port}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello http');

    await listener.stop();
  });

  it('HTTPS works with a self-signed cert generated at test time', async () => {
    // Generate self-signed certificate
    const pems: any = await (selfsigned as any).generate(
      [{ name: 'commonName', value: '127.0.0.1' }],
      { days: 1 }
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tls-'));
    const keyPath = path.join(tempDir, 'key.pem');
    const certPath = path.join(tempDir, 'cert.pem');
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);

    try {
      const listener = new ProxyListener(
        {
          listeners: {
            http: { host: '127.0.0.1', port: 0 },
            https: { host: '127.0.0.1', port: 0, keyPath, certPath },
          },
          handleSignals: false,
        },
        (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello https');
        }
      );

      await listener.start();
      const httpsPort = listener.httpsPort;
      expect(httpsPort).toBeDefined();
      expect(httpsPort).toBeGreaterThan(0);

      const res = await makeRequest(`https://127.0.0.1:${httpsPort}/secure`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('hello https');

      await listener.stop();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('shutdown waits for an in-flight request up to grace period', async () => {
    let requestFinished = false;

    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
        },
        shutdownGracePeriodMs: 2000,
        handleSignals: false,
      },
      (req, res) => {
        // Slow in-flight request takes 200ms
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('finished late');
          requestFinished = true;
        }, 200);
      }
    );

    await listener.start();
    const port = listener.httpPort!;

    // Send request without awaiting immediately
    const reqPromise = makeRequest(`http://127.0.0.1:${port}/slow`);

    // Wait 50ms for request to reach server
    await new Promise((r) => setTimeout(r, 50));
    expect(listener.inFlightCount).toBe(1);

    // Call stop() while request is in flight
    const stopPromise = listener.stop();

    // Verify stop completes after request finishes
    const [res] = await Promise.all([reqPromise, stopPromise]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('finished late');
    expect(requestFinished).toBe(true);
    expect(listener.inFlightCount).toBe(0);
  });

  it('bad cert path fails with a readable error on startup', async () => {
    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
          https: {
            host: '127.0.0.1',
            port: 0,
            keyPath: '/non/existent/path/to/key.pem',
            certPath: '/non/existent/path/to/cert.pem',
          },
        },
        handleSignals: false,
      },
      (req, res) => {
        res.end();
      }
    );

    await expect(listener.start()).rejects.toThrow(
      /Failed to read HTTPS key file/i
    );
  });
});
