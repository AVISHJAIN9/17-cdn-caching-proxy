import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createAndStartProxy } from '../src/proxy/index.js';
import {
  isPrivateOrReservedIp,
  isOriginAllowed,
  createSsrfProtectingLookup,
} from '../src/security/origin-access.js';

describe('Feature 89: Origin access control', () => {
  let originServer: http.Server | null = null;
  let originRequests: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  let proxyInstance: Awaited<ReturnType<typeof createAndStartProxy>> | null = null;

  async function startOrigin(): Promise<{ port: number; originUrl: string }> {
    originRequests = [];
    return new Promise((resolve) => {
      originServer = http.createServer((req, res) => {
        originRequests.push({ url: req.url, headers: req.headers });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ status: 'origin-ok' }));
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

  describe('SSRF Address Classification Unit Tests', () => {
    it('correctly classifies private, loopback, link-local, and cloud-metadata addresses', () => {
      // Cloud metadata (IMDS)
      expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true);

      // Loopback
      expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('127.123.45.67')).toBe(true);
      expect(isPrivateOrReservedIp('::1')).toBe(true);

      // Private RFC 1918
      expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.16.5.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.31.255.254')).toBe(true);
      expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);

      // IPv6 link-local & ULA
      expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
      expect(isPrivateOrReservedIp('fc00::1')).toBe(true);

      // Public Internet addresses (not reserved)
      expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
      expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
    });
  });

  describe('SSRF Protection & Explicit Allowlist', () => {
    it('blocks unallowlisted private/metadata origin URLs with 502 SSRF_BLOCKED', async () => {
      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: 'http://169.254.169.254/latest/meta-data',
        originAccess: {
          blockPrivateOrigins: true,
          allowedPrivateOrigins: [], // None allowed
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error?.code).toBe('SSRF_BLOCKED');
      expect(body.error?.message).toContain('SSRF defense');
    });

    it('allows explicitly allowlisted private origin', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        originAccess: {
          blockPrivateOrigins: true,
          allowedPrivateOrigins: [originUrl], // Explicitly allowlisted
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(200);
      expect(originRequests.length).toBe(1);
    });
  });

  describe('DNS Rebinding Protection at Connect Time', () => {
    it('intercepts DNS resolution at connect time and blocks rebind to private IP', async () => {
      // Simulate DNS rebinding: hostname looks like public domain 'rebind-test.com',
      // but DNS resolver returns 169.254.169.254 at connect time
      const mockDnsLookup = (
        hostname: string,
        _options: any,
        cb: (err: any, address?: any, family?: any) => void
      ) => {
        if (hostname === 'rebind-test.com') {
          // Rebinding attack returns AWS metadata IP
          cb(null, '169.254.169.254', 4);
        } else {
          cb(null, '127.0.0.1', 4);
        }
      };

      const ssrfLookup = createSsrfProtectingLookup(
        { blockPrivateOrigins: true, allowedPrivateOrigins: [] },
        mockDnsLookup as any
      );

      // Verify that lookup aborts with SSRF_BLOCKED error before connection is made
      await new Promise<void>((resolve, reject) => {
        ssrfLookup('rebind-test.com', {}, (err) => {
          try {
            expect(err).toBeDefined();
            expect(err.code).toBe('SSRF_BLOCKED');
            expect(err.message).toContain('DNS rebinding');
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });

  describe('Tenant Origin Mapping', () => {
    it('blocks a tenant from targeting an origin outside its configured allowlist', async () => {
      const { originUrl } = await startOrigin();

      // Configure multi-origin setup with tenant restrictions
      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        trustedProxies: ['127.0.0.1'],
        originsConfig: {
          defaultOrigin: 'origin-b',
          origins: {
            'origin-a': { url: originUrl },
            'origin-b': { url: 'http://unauthorized-origin.com' },
          },
        },
        originAccess: {
          tenantAllowedOrigins: {
            'tenant-finance': [originUrl], // tenant-finance only allowed to access originUrl
          },
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      // 1. Request with tenant-finance targeting unauthorized origin-b -> 403 Forbidden
      const resBlocked = await fetch(`http://127.0.0.1:${proxyPort}/data`, {
        headers: {
          'X-Tenant-Id': 'tenant-finance',
        },
      });

      expect(resBlocked.status).toBe(403);
      const bodyBlocked = await resBlocked.json();
      expect(bodyBlocked.error?.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(originRequests.length).toBe(0);
    });

    it('allows a tenant to access its permitted origin', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        trustedProxies: ['127.0.0.1'],
        originAccess: {
          tenantAllowedOrigins: {
            'tenant-retail': [originUrl],
          },
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      const resAllowed = await fetch(`http://127.0.0.1:${proxyPort}/data`, {
        headers: {
          'X-Tenant-Id': 'tenant-retail',
        },
      });

      expect(resAllowed.status).toBe(200);
      expect(originRequests.length).toBe(1);
    });
  });
});
