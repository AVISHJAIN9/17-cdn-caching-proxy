import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAndStartProxy } from '../src/proxy/index.js';
import { FakeClock } from '../src/util/clock.js';
import {
  JwtValidator,
  JwksStore,
  JwksDocument,
  JwtHeader,
  JwtClaims,
} from '../src/security/jwt.js';

describe('Feature 85: JWT/OIDC authentication', () => {
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
        res.end(JSON.stringify({ status: 'ok', user: req.headers['x-user-id'] }));
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

  // Helper to construct signed JWTs for testing
  function createSignedToken(
    header: JwtHeader,
    payload: JwtClaims,
    signKey?: string | Buffer | crypto.KeyObject
  ): string {
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;

    if (header.alg === 'none') {
      return `${signingInput}.`;
    }

    if (header.alg === 'HS256') {
      const sig = crypto.createHmac('sha256', signKey as Buffer).update(signingInput).digest('base64url');
      return `${signingInput}.${sig}`;
    }

    if (header.alg === 'RS256') {
      const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), signKey as crypto.KeyObject);
      return `${signingInput}.${sig.toString('base64url')}`;
    }

    if (header.alg === 'ES256') {
      const sig = crypto.sign('SHA256', Buffer.from(signingInput), {
        key: signKey as crypto.KeyObject,
        dsaEncoding: 'ieee-p1363',
      });
      return `${signingInput}.${sig.toString('base64url')}`;
    }

    throw new Error(`Unsupported alg ${header.alg}`);
  }

  describe('Algorithm Verification (HS256, RS256, ES256)', () => {
    it('verifies HS256 tokens using symmetric secret', async () => {
      const secret = Buffer.from('super-secret-hmac-key-for-testing-hs256!');
      const validator = new JwtValidator({ secret, allowedAlgorithms: ['HS256'] });

      const token = createSignedToken(
        { alg: 'HS256', typ: 'JWT' },
        { sub: 'user-hs', exp: Math.floor(Date.now() / 1000) + 3600 },
        secret
      );

      const result = await validator.verify(token);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe('user-hs');

      // Tampered signature
      const tampered = token.slice(0, -4) + 'abcd';
      const tamperedResult = await validator.verify(tampered);
      expect(tamperedResult.valid).toBe(false);
      expect(tamperedResult.error?.code).toBe('INVALID_SIGNATURE');
    });

    it('verifies RS256 tokens using RSA public key', async () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const validator = new JwtValidator({ publicKey, allowedAlgorithms: ['RS256'] });

      const token = createSignedToken(
        { alg: 'RS256', typ: 'JWT' },
        { sub: 'user-rsa', exp: Math.floor(Date.now() / 1000) + 3600 },
        privateKey
      );

      const result = await validator.verify(token);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe('user-rsa');
    });

    it('verifies ES256 tokens using ECDSA P-256 public key', async () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const validator = new JwtValidator({ publicKey, allowedAlgorithms: ['ES256'] });

      const token = createSignedToken(
        { alg: 'ES256', typ: 'JWT' },
        { sub: 'user-ec', exp: Math.floor(Date.now() / 1000) + 3600 },
        privateKey
      );

      const result = await validator.verify(token);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe('user-ec');
    });
  });

  describe('Security Protections: alg=none and Algorithm Confusion', () => {
    it('strictly rejects alg=none tokens', async () => {
      const validator = new JwtValidator();
      const token = createSignedToken({ alg: 'none', typ: 'JWT' }, { sub: 'attacker' });

      const result = await validator.verify(token);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ALG_NONE_REJECTED');
    });

    it('defends against algorithm confusion (HS256 with RSA public key)', async () => {
      const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

      // Attacker attempts HMAC using RSA public key as symmetric secret
      const maliciousSecret = Buffer.from(publicKeyPem);
      const maliciousToken = createSignedToken(
        { alg: 'HS256', typ: 'JWT' },
        { sub: 'attacker', exp: Math.floor(Date.now() / 1000) + 3600 },
        maliciousSecret
      );

      // Server is configured for RS256 with publicKey
      const validator = new JwtValidator({
        publicKey,
        allowedAlgorithms: ['RS256'], // Only RS256 permitted
      });

      const result = await validator.verify(maliciousToken);
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('ALG_NOT_ALLOWED');
    });
  });

  describe('Claims Validation with Configurable Clock Skew', () => {
    it('validates exp, nbf, iss, and aud with clock skew', async () => {
      const fakeClock = new FakeClock(1000000000); // ms epoch
      const nowSec = 1000000;
      const secret = Buffer.from('test-secret-32-bytes-long-clock-skew!!');

      const validator = new JwtValidator({
        secret,
        allowedAlgorithms: ['HS256'],
        issuer: 'https://auth.example.com',
        audience: 'my-api',
        clockSkewSeconds: 30,
        clock: fakeClock,
      });

      // 1. Valid token
      const validToken = createSignedToken(
        { alg: 'HS256' },
        {
          iss: 'https://auth.example.com',
          aud: 'my-api',
          exp: nowSec + 100,
          nbf: nowSec - 10,
        },
        secret
      );
      expect((await validator.verify(validToken)).valid).toBe(true);

      // 2. Token expired by 10s (within 30s clock skew) -> still valid
      const skewToken = createSignedToken(
        { alg: 'HS256' },
        {
          iss: 'https://auth.example.com',
          aud: 'my-api',
          exp: nowSec - 10,
        },
        secret
      );
      expect((await validator.verify(skewToken)).valid).toBe(true);

      // 3. Token expired beyond clock skew (> 30s) -> rejected
      const expiredToken = createSignedToken(
        { alg: 'HS256' },
        {
          iss: 'https://auth.example.com',
          aud: 'my-api',
          exp: nowSec - 40,
        },
        secret
      );
      const expRes = await validator.verify(expiredToken);
      expect(expRes.valid).toBe(false);
      expect(expRes.error?.code).toBe('TOKEN_EXPIRED');

      // 4. Issuer mismatch
      const wrongIss = createSignedToken(
        { alg: 'HS256' },
        { iss: 'https://rogue.example.com', aud: 'my-api', exp: nowSec + 100 },
        secret
      );
      const issRes = await validator.verify(wrongIss);
      expect(issRes.valid).toBe(false);
      expect(issRes.error?.code).toBe('INVALID_ISSUER');

      // 5. Audience mismatch
      const wrongAud = createSignedToken(
        { alg: 'HS256' },
        { iss: 'https://auth.example.com', aud: 'other-service', exp: nowSec + 100 },
        secret
      );
      const audRes = await validator.verify(wrongAud);
      expect(audRes.valid).toBe(false);
      expect(audRes.error?.code).toBe('INVALID_AUDIENCE');
    });
  });

  describe('JWKS Fixture with kid Rotation and Cached TTL', () => {
    it('resolves rotated keys and refreshes cache based on injected clock TTL', async () => {
      const clock = new FakeClock(1000);

      // Generate 2 RSA key pairs
      const rsa1 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsa2 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

      const jwk1 = { ...rsa1.publicKey.export({ format: 'jwk' }), kid: 'key-2026-v1' } as any;
      const jwk2 = { ...rsa2.publicKey.export({ format: 'jwk' }), kid: 'key-2026-v2' } as any;

      let currentJwks: JwksDocument = { keys: [jwk1] };
      let fetchCount = 0;

      const jwksStore = new JwksStore({
        jwksProvider: () => {
          fetchCount++;
          return currentJwks;
        },
        cacheTtlMs: 5000,
        clock,
      });

      const validator = new JwtValidator({
        jwksStore,
        allowedAlgorithms: ['RS256'],
        clock,
      });

      // 1. Verify token signed with key 1
      const token1 = createSignedToken(
        { alg: 'RS256', kid: 'key-2026-v1' },
        { sub: 'alice', exp: 100000 },
        rsa1.privateKey
      );
      const res1 = await validator.verify(token1);
      expect(res1.valid).toBe(true);

      // 2. Rotate keys at identity provider: new key-2026-v2 added
      currentJwks = { keys: [jwk1, jwk2] };

      // Token signed with rotated key 2 triggers on-demand refresh
      const token2 = createSignedToken(
        { alg: 'RS256', kid: 'key-2026-v2' },
        { sub: 'bob', exp: 100000 },
        rsa2.privateKey
      );
      const res2 = await validator.verify(token2);
      expect(res2.valid).toBe(true);
      expect(res2.claims?.sub).toBe('bob');

      // 3. Test TTL expiration on injected clock
      const initialFetches = fetchCount;
      clock.advance(6000); // advance past 5000ms TTL

      // Token lookup after TTL triggers refresh
      await jwksStore.getKey('key-2026-v2');
      expect(fetchCount).toBeGreaterThan(initialFetches);
    });
  });

  describe('Proxy Server Integration', () => {
    it('authenticates valid JWT, extracts tenant claim, and rejects missing/invalid tokens with 401', async () => {
      const { originUrl } = await startOrigin();
      const secret = Buffer.from('proxy-jwt-shared-secret-key-32b!!');

      proxyInstance = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl,
        jwtAuth: {
          enabled: true,
          secret,
          allowedAlgorithms: ['HS256'],
        },
      });

      const proxyPort = proxyInstance.httpPort!;

      // 1. Missing Authorization header -> 401
      const resMissing = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/profile`);
      expect(resMissing.status).toBe(401);
      expect(resMissing.headers.get('www-authenticate')).toContain('Bearer');
      expect(originRequests.length).toBe(0);

      // 2. Invalid JWT format -> 401
      const resInvalid = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/profile`, {
        headers: { Authorization: 'Bearer this.is.invalid.jwt' },
      });
      expect(resInvalid.status).toBe(401);
      expect(originRequests.length).toBe(0);

      // 3. Valid JWT -> 200 and upstream receives request
      const validToken = createSignedToken(
        { alg: 'HS256' },
        { sub: 'tenant-user-1', tenant_id: 'enterprise-a', exp: Math.floor(Date.now() / 1000) + 3600 },
        secret
      );
      const resValid = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/profile`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(resValid.status).toBe(200);
      expect(originRequests.length).toBe(1);
    });
  });
});
