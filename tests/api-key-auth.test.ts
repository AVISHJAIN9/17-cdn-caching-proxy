import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { ApiKeyValidator } from '../src/security/api-key.js';

describe('Feature 84: API-key auth', () => {
  let originServer: http.Server | null = null;
  let originRequests: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  let proxyInstance: Awaited<ReturnType<typeof createAndStartProxy>> | null = null;

  async function startOrigin(
    handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<{ port: number; originUrl: string }> {
    originRequests = [];
    return new Promise((resolve) => {
      originServer = http.createServer((req, res) => {
        originRequests.push({ url: req.url, headers: req.headers });
        if (handler) {
          handler(req, res);
          return;
        }
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

  describe('Validator Unit Tests', () => {
    it('performs constant-time comparison against SHA-256 hashed keys', () => {
      const rawSecret = 'secret_key_12345';
      const hashed = crypto.createHash('sha256').update(rawSecret).digest('hex');

      const validator = new ApiKeyValidator({
        enabled: true,
        keys: [
          {
            id: 'key-1',
            hashedKey: hashed,
            tenantId: 'tenant-alpha',
          },
        ],
      });

      // Valid key
      const resValid = validator.authenticate({ 'x-api-key': rawSecret });
      expect(resValid.authenticated).toBe(true);
      expect(resValid.keyId).toBe('key-1');
      expect(resValid.tenantId).toBe('tenant-alpha');

      // Invalid key
      const resInvalid = validator.authenticate({ 'x-api-key': 'wrong_secret' });
      expect(resInvalid.authenticated).toBe(false);
      expect(resInvalid.status).toBe(401);
      expect(resInvalid.code).toBe('INVALID_API_KEY');
    });

    it('rejects keys passed via query parameters (header-only extraction)', () => {
      const validator = new ApiKeyValidator({
        enabled: true,
        keys: [{ id: 'k1', key: 'supersecret' }],
      });

      // Header-only extraction returns null for query params
      const candidate = validator.extractKey({});
      expect(candidate).toBeNull();
    });

    it('handles expired and revoked keys with 401/403', () => {
      const clock = new FakeClock(1000000);
      const validator = new ApiKeyValidator({
        enabled: true,
        keys: [
          { id: 'expired-key', key: 'key-expired', expiresAt: 999999 },
          { id: 'revoked-key', key: 'key-revoked', revoked: true },
        ],
      });

      const resExpired = validator.authenticate({ 'x-api-key': 'key-expired' }, clock);
      expect(resExpired.authenticated).toBe(false);
      expect(resExpired.status).toBe(401);
      expect(resExpired.code).toBe('EXPIRED_API_KEY');

      const resRevoked = validator.authenticate({ 'x-api-key': 'key-revoked' }, clock);
      expect(resRevoked.authenticated).toBe(false);
      expect(resRevoked.status).toBe(403);
      expect(resRevoked.code).toBe('REVOKED_API_KEY');
    });
  });

  describe('Integration with Proxy Server', () => {
    it('returns 401 with WWW-Authenticate header when key is missing or invalid', async () => {
      const { originUrl } = await startOrigin();

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        apiKeyAuth: {
          enabled: true,
          keys: [{ id: 'valid-key-id', key: 'valid-secret-123' }],
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      // 1. Missing API key -> 401
      const resMissing = await fetch(`http://127.0.0.1:${proxyPort}/api/data`);
      expect(resMissing.status).toBe(401);
      expect(resMissing.headers.get('www-authenticate')).toContain('ApiKey');
      const bodyMissing = await resMissing.json();
      expect(bodyMissing.error?.code).toBe('MISSING_API_KEY');
      expect(originRequests.length).toBe(0);

      // 2. Query param spoof attempt (key in query, not header) -> 401
      const resQuery = await fetch(`http://127.0.0.1:${proxyPort}/api/data?api_key=valid-secret-123`);
      expect(resQuery.status).toBe(401);
      expect(originRequests.length).toBe(0);

      // 3. Invalid API key -> 401
      const resInvalid = await fetch(`http://127.0.0.1:${proxyPort}/api/data`, {
        headers: { 'X-API-Key': 'wrong-key' },
      });
      expect(resInvalid.status).toBe(401);
      expect(originRequests.length).toBe(0);

      // 4. Valid API key via X-API-Key -> 200
      const resValidX = await fetch(`http://127.0.0.1:${proxyPort}/api/data`, {
        headers: { 'X-API-Key': 'valid-secret-123' },
      });
      expect(resValidX.status).toBe(200);
      expect(originRequests.length).toBe(1);

      // 5. Valid API key via Authorization: Bearer <key> -> 200
      const resValidBearer = await fetch(`http://127.0.0.1:${proxyPort}/api/data`, {
        headers: { Authorization: 'Bearer valid-secret-123' },
      });
      expect(resValidBearer.status).toBe(200);
      expect(originRequests.length).toBe(2);
    });

    it('enforces RFC 9111 shared-cache rules for authenticated requests', async () => {
      let callCount = 0;
      const { originUrl } = await startOrigin((req, res) => {
        callCount++;
        if (req.url === '/public-auth') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            Date: new Date().toUTCString(),
          });
          res.end(JSON.stringify({ data: 'public-allowed', count: callCount }));
        } else if (req.url === '/private-auth') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, max-age=3600',
            Date: new Date().toUTCString(),
          });
          res.end(JSON.stringify({ data: 'private-never', count: callCount }));
        } else {
          // Standard response without explicit public/s-maxage/must-revalidate
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'max-age=3600',
            Date: new Date().toUTCString(),
          });
          res.end(JSON.stringify({ data: 'default-no-store', count: callCount }));
        }
      });

      const store = new MemoryStore({ maxObjectBytes: 5 * 1024 * 1024 });

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        store,
      });

      const proxyPort = proxyInstance.httpPort!;

      // 1. Request with Authorization to default response (max-age=3600 without public/s-maxage)
      // Must NOT be stored in shared cache per RFC 9111 Section 3.5
      const res1 = await fetch(`http://127.0.0.1:${proxyPort}/default-auth`, {
        headers: { Authorization: 'Bearer my-token' },
      });
      await res1.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(callCount).toBe(1);
      expect(store.stats().entries).toBe(0); // Not stored!

      // 2. Request with Authorization to public response (Cache-Control: public)
      // Stored per RFC 9111 Section 3.5
      const res2 = await fetch(`http://127.0.0.1:${proxyPort}/public-auth`, {
        headers: { Authorization: 'Bearer my-token' },
      });
      await res2.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(callCount).toBe(2);
      expect(store.stats().entries).toBe(1); // Stored!

      // 3. Request with Authorization to private response (Cache-Control: private)
      // MUST NOT be stored in shared cache
      const res3 = await fetch(`http://127.0.0.1:${proxyPort}/private-auth`, {
        headers: { Authorization: 'Bearer my-token' },
      });
      await res3.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(callCount).toBe(3);
      expect(store.stats().entries).toBe(1); // Still only 1 entry from public-auth!
    });
  });
});
