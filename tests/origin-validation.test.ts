import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as selfsigned from 'selfsigned';
import {
  validateOriginConfig,
  validateOriginReachability,
  parseOriginsConfig,
} from '../src/config/origins.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 48: Origin validation', () => {
  let httpsOriginServer: https.Server;
  let httpsPort: number;
  let selfSignedCert: string;
  let selfSignedKey: string;

  let httpOriginServer: http.Server;
  let httpPort: number;

  beforeAll(async () => {
    // Generate self-signed certificate for test HTTPS origin
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
    selfSignedKey = pems.private;

    // Start HTTPS origin server
    httpsOriginServer = https.createServer(
      { key: selfSignedKey, cert: selfSignedCert },
      (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'date': new Date().toUTCString(),
          'cache-control': 'public, max-age=60',
        });
        res.end(JSON.stringify({ status: 'ok', secure: true }));
      }
    );

    await new Promise<void>((resolve) => {
      httpsOriginServer.listen(0, '127.0.0.1', () => {
        httpsPort = (httpsOriginServer.address() as any).port;
        resolve();
      });
    });

    // Start HTTP origin server
    httpOriginServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'date': new Date().toUTCString(),
        'cache-control': 'public, max-age=60',
      });
      res.end(JSON.stringify({ status: 'ok', secure: false }));
    });

    await new Promise<void>((resolve) => {
      httpOriginServer.listen(0, '127.0.0.1', () => {
        httpPort = (httpOriginServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => httpsOriginServer.close(() => r()));
    await new Promise<void>((r) => httpOriginServer.close(() => r()));
  });

  describe('Configuration & Schema Validation', () => {
    it('validates a correct origin entry', () => {
      const result = validateOriginConfig({
        url: 'https://api.example.com:8443/v1',
        hostHeader: 'api.example.com',
        verifyTls: true,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects unsupported protocols (ftp, ws, gopher)', () => {
      const resFtp = validateOriginConfig({ url: 'ftp://ftp.example.com' });
      expect(resFtp.valid).toBe(false);
      expect(resFtp.errors.some((e) => e.includes('http:') || e.includes('https:'))).toBe(true);

      const resWs = validateOriginConfig({ url: 'ws://ws.example.com' });
      expect(resWs.valid).toBe(false);
    });

    it('rejects origin URLs with embedded user credentials', () => {
      const result = validateOriginConfig({ url: 'https://admin:secret@api.example.com' });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('credentials'))).toBe(true);
    });

    it('rejects origin URLs with query strings or hash fragments', () => {
      const resQuery = validateOriginConfig({ url: 'https://api.example.com/api?debug=1' });
      expect(resQuery.valid).toBe(false);
      expect(resQuery.errors.some((e) => e.includes('query'))).toBe(true);

      const resHash = validateOriginConfig({ url: 'https://api.example.com/api#section' });
      expect(resHash.valid).toBe(false);
      expect(resHash.errors.some((e) => e.includes('fragments'))).toBe(true);
    });

    it('rejects out of range port numbers', () => {
      const resHigh = validateOriginConfig({ url: 'https://api.example.com:70000' });
      expect(resHigh.valid).toBe(false);
      expect(resHigh.errors.some((e) => e.includes('Port out of range'))).toBe(true);
    });

    it('rejects invalid hostHeader format', () => {
      const result = validateOriginConfig({
        url: 'https://api.example.com',
        hostHeader: 'http://not-a-valid-host',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('hostHeader must be a valid host'))).toBe(true);
    });
  });

  describe('Live Upstream TLS Certificate Verification', () => {
    it('fails with 502 UPSTREAM_TLS_ERROR when origin certificate is self-signed and verifyTls is true (default)', async () => {
      const proxy = await createAndStartProxy({
        originUrl: `https://127.0.0.1:${httpsPort}`,
        originsConfig: {
          origins: {
            default: {
              url: `https://127.0.0.1:${httpsPort}`,
              verifyTls: true,
            },
          },
          defaultOrigin: 'default',
        },
        port: 0,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/test`);
        expect(res.status).toBe(502);

        const data: any = await res.json();
        expect(data.error.code).toBe('UPSTREAM_TLS_ERROR');
      } finally {
        await proxy.close();
      }
    });

    it('succeeds with 200 OK when verifyTls is explicitly false', async () => {
      const proxy = await createAndStartProxy({
        originUrl: `https://127.0.0.1:${httpsPort}`,
        originsConfig: {
          origins: {
            default: {
              url: `https://127.0.0.1:${httpsPort}`,
              verifyTls: false,
            },
          },
          defaultOrigin: 'default',
        },
        port: 0,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/test`);
        expect(res.status).toBe(200);

        const data: any = await res.json();
        expect(data.status).toBe('ok');
        expect(data.secure).toBe(true);
      } finally {
        await proxy.close();
      }
    });

    it('succeeds with 200 OK when verifyTls is true and custom CA certificate is provided', async () => {
      const proxy = await createAndStartProxy({
        originUrl: `https://127.0.0.1:${httpsPort}`,
        originsConfig: {
          origins: {
            default: {
              url: `https://127.0.0.1:${httpsPort}`,
              verifyTls: true,
              ca: selfSignedCert,
            },
          },
          defaultOrigin: 'default',
        },
        port: 0,
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/test`);
        expect(res.status).toBe(200);

        const data: any = await res.json();
        expect(data.status).toBe('ok');
        expect(data.secure).toBe(true);
      } finally {
        await proxy.close();
      }
    });
  });

  describe('Active Reachability Probing', () => {
    it('returns reachable: true for reachable HTTP origin', async () => {
      const result = await validateOriginReachability({
        url: `http://127.0.0.1:${httpPort}`,
      });
      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('returns reachable: false with UPSTREAM_CONNECT_FAILED for unreachable port', async () => {
      const result = await validateOriginReachability({
        url: 'http://127.0.0.1:49999',
      });
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('UPSTREAM_CONNECT_FAILED');
    });

    it('returns reachable: false with UPSTREAM_TLS_ERROR for self-signed HTTPS origin with verifyTls=true', async () => {
      const result = await validateOriginReachability({
        url: `https://127.0.0.1:${httpsPort}`,
        verifyTls: true,
      });
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('UPSTREAM_TLS_ERROR');
    });

    it('returns reachable: true for self-signed HTTPS origin with verifyTls=false', async () => {
      const result = await validateOriginReachability({
        url: `https://127.0.0.1:${httpsPort}`,
        verifyTls: false,
      });
      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
    });
  });
});
