import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createAndStartProxy } from '../src/proxy/index.js';
import {
  isIpMatch,
  isIpInList,
  resolveClientIp,
  evaluateIpAccess,
} from '../src/security/ip.js';

describe('Features 86 & 87: IP allowlist and IP denylist', () => {
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
        res.end(JSON.stringify({ status: 'ok' }));
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

  describe('CIDR matching unit tests', () => {
    it('matches IPv4 CIDRs correctly across prefixes (/8, /16, /24, /32)', () => {
      expect(isIpMatch('192.168.1.50', '192.168.1.0/24')).toBe(true);
      expect(isIpMatch('192.168.2.50', '192.168.1.0/24')).toBe(false);

      expect(isIpMatch('10.250.1.1', '10.0.0.0/8')).toBe(true);
      expect(isIpMatch('11.0.0.1', '10.0.0.0/8')).toBe(false);

      expect(isIpMatch('172.16.5.10', '172.16.0.0/16')).toBe(true);
      expect(isIpMatch('172.17.5.10', '172.16.0.0/16')).toBe(false);

      expect(isIpMatch('1.2.3.4', '1.2.3.4/32')).toBe(true);
      expect(isIpMatch('1.2.3.5', '1.2.3.4/32')).toBe(false);
    });

    it('matches IPv6 CIDRs correctly (/32, /64, /128)', () => {
      expect(isIpMatch('2001:db8:abcd:0012::1', '2001:db8::/32')).toBe(true);
      expect(isIpMatch('2001:db9::1', '2001:db8::/32')).toBe(false);

      expect(isIpMatch('2001:db8:a:b:1:2:3:4', '2001:db8:a:b::/64')).toBe(true);
      expect(isIpMatch('2001:db8:a:c:1:2:3:4', '2001:db8:a:b::/64')).toBe(false);

      expect(isIpMatch('::1', '::1/128')).toBe(true);
      expect(isIpMatch('::2', '::1/128')).toBe(false);
    });

    it('handles IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)', () => {
      expect(isIpMatch('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
      expect(isIpMatch('::ffff:192.168.2.5', '192.168.1.0/24')).toBe(false);

      expect(isIpMatch('192.168.1.5', '::ffff:192.168.1.0/120')).toBe(true);
      expect(isIpMatch('::ffff:10.0.0.1', '10.0.0.0/8')).toBe(true);
    });
  });

  describe('Client IP resolution with trusted proxies unit tests', () => {
    it('ignores client-supplied XFF if direct peer is not trusted (spoof protection)', () => {
      const resolved = resolveClientIp('198.51.100.1', '1.2.3.4, 5.6.7.8', ['10.0.0.0/8']);
      expect(resolved).toBe('198.51.100.1');
    });

    it('walks XFF right-to-left when direct peer is trusted', () => {
      // Direct peer is 10.0.0.1 (trusted)
      // XFF has: 203.0.113.195 (client), 10.0.0.2 (trusted proxy)
      const resolved = resolveClientIp(
        '10.0.0.1',
        '203.0.113.195, 10.0.0.2',
        ['10.0.0.0/8']
      );
      expect(resolved).toBe('203.0.113.195');
    });

    it('returns leftmost IP if all proxies in chain are trusted', () => {
      const resolved = resolveClientIp(
        '10.0.0.1',
        '10.0.0.3, 10.0.0.2',
        ['10.0.0.0/8']
      );
      expect(resolved).toBe('10.0.0.3');
    });
  });

  describe('Denylist precedence and integration tests', () => {
    it('enforces that denylist takes precedence over allowlist, returning 403 with no upstream request', async () => {
      const { originUrl } = await startOrigin();

      // Configure allowlist for entire 127.0.0.0/8, but denylist 127.0.0.1
      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        ipAllowlist: ['127.0.0.0/8'],
        ipDenylist: ['127.0.0.1/32'],
      });

      const proxyPort = proxyInstance.httpPort!;

      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error?.code).toBe('FORBIDDEN');
      expect(body.error?.message).toContain('denied');
      expect(originRequests.length).toBe(0); // Upstream was NOT contacted!
    });

    it('blocks IP not matching allowlist with 403 Forbidden', async () => {
      const { originUrl } = await startOrigin();

      // Configure allowlist that does NOT include 127.0.0.1
      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        ipAllowlist: ['10.0.0.0/8', '192.168.0.0/16'],
      });

      const proxyPort = proxyInstance.httpPort!;

      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error?.code).toBe('FORBIDDEN');
      expect(body.error?.message).toContain('not in allowlist');
      expect(originRequests.length).toBe(0);
    });

    it('allows request when client IP is in allowlist and not denylisted', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        ipAllowlist: ['127.0.0.0/8'],
        ipDenylist: ['192.168.1.1'],
      });

      const proxyPort = proxyInstance.httpPort!;

      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`);
      expect(res.status).toBe(200);
      expect(originRequests.length).toBe(1);
    });

    it('enforces trusted proxies and right-to-left X-Forwarded-For evaluation', async () => {
      const { originUrl } = await startOrigin();

      // Connecting peer is 127.0.0.1 (trusted)
      // Denylist: 198.51.100.77
      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        trustedProxies: ['127.0.0.1', '10.0.0.0/8'],
        ipDenylist: ['198.51.100.77'],
      });

      const proxyPort = proxyInstance.httpPort!;

      // 1. Untrusted client 198.51.100.77 passing through trusted proxy 10.0.0.5 -> blocked!
      const resBlocked = await fetch(`http://127.0.0.1:${proxyPort}/api`, {
        headers: {
          'X-Forwarded-For': '198.51.100.77, 10.0.0.5',
        },
      });
      expect(resBlocked.status).toBe(403);
      expect(originRequests.length).toBe(0);

      // 2. Allowed client 198.51.100.99 passing through trusted proxy 10.0.0.5 -> allowed!
      const resAllowed = await fetch(`http://127.0.0.1:${proxyPort}/api`, {
        headers: {
          'X-Forwarded-For': '198.51.100.99, 10.0.0.5',
        },
      });
      expect(resAllowed.status).toBe(200);
      expect(originRequests.length).toBe(1);
    });
  });
});
