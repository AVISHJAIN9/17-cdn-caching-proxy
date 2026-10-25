import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createAndStartProxy } from '../src/proxy/index.js';
import { normalizeHost, isHostAllowed } from '../src/security/host.js';

describe('Feature 88: Host allowlist', () => {
  let originServer: http.Server | null = null;
  let originRequests: { url?: string; host?: string }[] = [];
  let proxyInstance: Awaited<ReturnType<typeof createAndStartProxy>> | null = null;

  async function startOrigin(): Promise<{ port: number; originUrl: string }> {
    originRequests = [];
    return new Promise((resolve) => {
      originServer = http.createServer((req, res) => {
        originRequests.push({ url: req.url, host: req.headers.host });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ status: 'ok', host: req.headers.host }));
      });
      originServer.listen(0, '127.0.0.1', () => {
        const addr = originServer!.address() as any;
        resolve({ port: addr.port, originUrl: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  afterEach(async () => {
    if (proxyInstance) {
      await proxyInstance.close();
      proxyInstance = null;
    }
    if (originServer) {
      await new Promise<void>((res) => originServer!.close(() => res()));
      originServer = null;
    }
  });

  describe('Host normalization unit tests', () => {
    it('strips default ports :80 and :443, preserving other ports', () => {
      expect(normalizeHost('example.com:80')).toBe('example.com');
      expect(normalizeHost('example.com:443')).toBe('example.com');
      expect(normalizeHost('example.com:8080')).toBe('example.com:8080');
      expect(normalizeHost('[::1]:80')).toBe('[::1]');
      expect(normalizeHost('[::1]:443')).toBe('[::1]');
      expect(normalizeHost('[::1]:8443')).toBe('[::1]:8443');
    });

    it('normalizes case insensitivity and trailing dots', () => {
      expect(normalizeHost('EXAMPLE.COM')).toBe('example.com');
      expect(normalizeHost('example.com.')).toBe('example.com');
      expect(normalizeHost('EXAMPLE.COM.:80')).toBe('example.com');
    });

    it('normalizes IDN and Punycode', () => {
      const puny = 'xn--mnchen-3ya.de';
      expect(normalizeHost('münchen.de')).toBe(puny);
      expect(normalizeHost('MÜNCHEN.DE.')).toBe(puny);
      expect(normalizeHost(puny)).toBe(puny);
    });

    it('matches allowed hosts with wildcards and normalization', () => {
      const allowed = ['example.com', '*.cdn.net', 'xn--mnchen-3ya.de'];
      expect(isHostAllowed('example.com', allowed)).toBe(true);
      expect(isHostAllowed('EXAMPLE.COM:80', allowed)).toBe(true);
      expect(isHostAllowed('example.com.', allowed)).toBe(true);
      expect(isHostAllowed('sub.cdn.net', allowed)).toBe(true);
      expect(isHostAllowed('a.b.cdn.net:443', allowed)).toBe(true);
      expect(isHostAllowed('münchen.de', allowed)).toBe(true);

      expect(isHostAllowed('attacker.com', allowed)).toBe(false);
      expect(isHostAllowed('notcdn.net', allowed)).toBe(false);
    });
  });

  describe('Proxy server integration tests', () => {
    it('allows valid requests and rejects unknown hosts with 421 without contacting origin', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        allowedHosts: ['api.example.com', 'münchen.de', '*.static.net'],
      });

      const proxyPort = proxyInstance.httpPort!;

      const makeRawRequest = (rawPath: string, hostHeader: string): Promise<{ status: number; body: string }> => {
        return new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: proxyPort,
              path: rawPath,
              method: 'GET',
              headers: { Host: hostHeader },
            },
            (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
            }
          );
          req.on('error', reject);
          req.end();
        });
      };

      // 1. Valid request to api.example.com:80
      const res1 = await makeRawRequest('/data', 'api.example.com:80');
      expect(res1.status).toBe(200);
      expect(originRequests.length).toBe(1);

      // 2. Valid request to IDN punycode host with trailing dot
      const res2 = await makeRawRequest('/data', 'xn--mnchen-3ya.de.');
      expect(res2.status).toBe(200);
      expect(originRequests.length).toBe(2);

      // 3. Valid wildcard subdomain
      const res3 = await makeRawRequest('/data', 'img.static.net:443');
      expect(res3.status).toBe(200);
      expect(originRequests.length).toBe(3);

      // 4. Unknown host -> 421 Misdirected Request, origin NOT contacted
      const res4 = await makeRawRequest('/data', 'unauthorized-domain.com');
      expect(res4.status).toBe(421);
      const body4 = JSON.parse(res4.body);
      expect(body4.error?.code).toBe('MISDIRECTED_REQUEST');
      expect(originRequests.length).toBe(3); // untouched!
    });

    it('supports custom rejectStatusCode (404) for unknown hosts', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        hostAllowlist: {
          allowedHosts: ['allowed.org'],
          rejectStatusCode: 404,
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      const makeRawRequest = (rawPath: string, hostHeader: string): Promise<{ status: number; body: string }> => {
        return new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: proxyPort,
              path: rawPath,
              method: 'GET',
              headers: { Host: hostHeader },
            },
            (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
            }
          );
          req.on('error', reject);
          req.end();
        });
      };

      const res = await makeRawRequest('/path', 'disallowed.org');
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error?.code).toBe('NOT_FOUND');
      expect(originRequests.length).toBe(0);
    });

    it('enforces that absolute-form request target must match Host header', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        allowedHosts: ['example.com'],
      });

      const proxyPort = proxyInstance.httpPort!;

      // Test using raw HTTP request to send absolute-form URI
      const makeRawRequest = (rawPath: string, hostHeader: string): Promise<{ status: number; body: string }> => {
        return new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: proxyPort,
              path: rawPath,
              method: 'GET',
              headers: { Host: hostHeader },
            },
            (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
            }
          );
          req.on('error', reject);
          req.end();
        });
      };

      // 1. Matching absolute-form target (http://example.com:80/resource with Host: example.com)
      const matching = await makeRawRequest('http://example.com:80/resource', 'example.com');
      expect(matching.status).toBe(200);

      // 2. Mismatching absolute-form target (http://different.com/resource with Host: example.com)
      const mismatch = await makeRawRequest('http://different.com/resource', 'example.com');
      expect(mismatch.status).toBe(400);
      const parsed = JSON.parse(mismatch.body);
      expect(parsed.error?.code).toBe('HOST_TARGET_MISMATCH');
    });
  });
});
