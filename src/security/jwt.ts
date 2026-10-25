import crypto from 'node:crypto';
import { Clock, SystemClock } from '../util/clock.js';

export type JwtAlgorithm = 'HS256' | 'RS256' | 'ES256';

export interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
  [key: string]: any;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  tenant_id?: string;
  tenantId?: string;
  roles?: string[];
  [key: string]: any;
}

export interface DecodedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
}

export interface JwkKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: any;
}

export interface JwksDocument {
  keys: JwkKey[];
}

export interface JwksStoreConfig {
  jwks?: JwksDocument;
  jwksProvider?: () => Promise<JwksDocument> | JwksDocument;
  cacheTtlMs?: number; // default: 300,000 ms (5 minutes)
  clock?: Clock;
}

/**
 * In-memory JWKS Store with TTL caching and kid rotation support on an injected clock.
 */
export class JwksStore {
  private jwks?: JwksDocument;
  private readonly jwksProvider?: () => Promise<JwksDocument> | JwksDocument;
  private readonly cacheTtlMs: number;
  private readonly clock: Clock;
  private lastFetchedMs = 0;
  private keyCache = new Map<string, crypto.KeyObject>();

  constructor(config: JwksStoreConfig) {
    this.jwks = config.jwks;
    this.jwksProvider = config.jwksProvider;
    this.cacheTtlMs = config.cacheTtlMs ?? 300000;
    this.clock = config.clock ?? new SystemClock();

    if (this.jwks) {
      this.loadKeys(this.jwks);
      this.lastFetchedMs = this.clock.now();
    }
  }

  private loadKeys(jwks: JwksDocument): void {
    this.keyCache.clear();
    for (const jwk of jwks.keys) {
      if (!jwk.kid) continue;
      try {
        const keyObject = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
        this.keyCache.set(jwk.kid, keyObject);
      } catch (err: any) {
        console.warn(`Failed to import JWK with kid "${jwk.kid}": ${err.message}`);
      }
    }
  }

  public async getKey(kid: string): Promise<crypto.KeyObject | undefined> {
    const now = this.clock.now();
    const isExpired = now - this.lastFetchedMs > this.cacheTtlMs;

    // If key not found or cache expired and provider exists, refresh
    if ((!this.keyCache.has(kid) || isExpired) && this.jwksProvider) {
      try {
        const refreshed = await this.jwksProvider();
        this.jwks = refreshed;
        this.loadKeys(refreshed);
        this.lastFetchedMs = now;
      } catch (err: any) {
        console.error(`Failed to refresh JWKS: ${err.message}`);
      }
    }

    return this.keyCache.get(kid);
  }

  public setJwks(jwks: JwksDocument): void {
    this.jwks = jwks;
    this.loadKeys(jwks);
    this.lastFetchedMs = this.clock.now();
  }
}

export interface JwtVerifyOptions {
  allowedAlgorithms?: readonly JwtAlgorithm[];
  issuer?: string;
  audience?: string | string[];
  clockSkewSeconds?: number; // default: 60 seconds
  secret?: string | Buffer; // for HS256
  publicKey?: string | Buffer | crypto.KeyObject; // for RS256 / ES256
  jwksStore?: JwksStore;
  clock?: Clock;
}

export interface JwtValidationResult {
  valid: boolean;
  claims?: JwtClaims;
  header?: JwtHeader;
  error?: {
    code:
      | 'MALFORMED_TOKEN'
      | 'ALG_NOT_ALLOWED'
      | 'ALG_NONE_REJECTED'
      | 'ALGORITHM_CONFUSION'
      | 'INVALID_SIGNATURE'
      | 'TOKEN_EXPIRED'
      | 'TOKEN_NOT_YET_VALID'
      | 'INVALID_ISSUER'
      | 'INVALID_AUDIENCE'
      | 'UNKNOWN_KID';
    message: string;
  };
}

export class JwtValidator {
  private readonly allowedAlgorithms: readonly JwtAlgorithm[];
  private readonly issuer?: string;
  private readonly audience?: string | string[];
  private readonly clockSkewSeconds: number;
  private readonly secret?: Buffer;
  private readonly publicKey?: crypto.KeyObject;
  private readonly jwksStore?: JwksStore;
  private readonly clock: Clock;

  constructor(options: JwtVerifyOptions = {}) {
    this.allowedAlgorithms = options.allowedAlgorithms ?? ['HS256', 'RS256', 'ES256'];
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 60;
    this.clock = options.clock ?? new SystemClock();
    this.jwksStore = options.jwksStore;

    if (options.secret) {
      this.secret = Buffer.isBuffer(options.secret)
        ? options.secret
        : Buffer.from(options.secret);
    }

    if (options.publicKey) {
      if (options.publicKey instanceof crypto.KeyObject) {
        this.publicKey = options.publicKey;
      } else {
        this.publicKey = crypto.createPublicKey(options.publicKey);
      }
    }
  }

  /**
   * Decodes a JWT into header, claims, signingInput, and raw signature.
   */
  public static decode(rawToken: string): DecodedJwt {
    const parts = rawToken.trim().split('.');
    if (parts.length !== 3) {
      throw new Error('MALFORMED_TOKEN: Token must contain exactly 3 dot-separated parts');
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header: JwtHeader;
    let claims: JwtClaims;

    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('MALFORMED_TOKEN: Invalid JSON in JWT header');
    }

    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('MALFORMED_TOKEN: Invalid JSON in JWT payload');
    }

    const signature = Buffer.from(signatureB64, 'base64url');
    const signingInput = `${headerB64}.${payloadB64}`;

    return { header, claims, signingInput, signature };
  }

  /**
   * Validates token signature, algorithm confusion defenses, and claims.
   */
  public async verify(rawToken: string): Promise<JwtValidationResult> {
    let decoded: DecodedJwt;
    try {
      decoded = JwtValidator.decode(rawToken);
    } catch (err: any) {
      return {
        valid: false,
        error: { code: 'MALFORMED_TOKEN', message: err.message },
      };
    }

    const { header, claims, signingInput, signature } = decoded;

    // 1. Explicitly reject alg = none
    if (!header.alg || header.alg.toLowerCase() === 'none') {
      return {
        valid: false,
        error: { code: 'ALG_NONE_REJECTED', message: 'Algorithm "none" is strictly forbidden' },
      };
    }

    const alg = header.alg as JwtAlgorithm;

    // 2. Allowed algorithms check
    if (!this.allowedAlgorithms.includes(alg)) {
      return {
        valid: false,
        error: {
          code: 'ALG_NOT_ALLOWED',
          message: `Algorithm "${header.alg}" is not in permitted algorithms: ${this.allowedAlgorithms.join(', ')}`,
        },
      };
    }

    // 3. Resolve key and perform Algorithm Confusion Defenses
    let verificationKey: Buffer | crypto.KeyObject;

    if (alg === 'HS256') {
      if (!this.secret) {
        return {
          valid: false,
          error: {
            code: 'ALGORITHM_CONFUSION',
            message: 'HS256 requires symmetric secret, but no secret is configured',
          },
        };
      }
      verificationKey = this.secret;
    } else {
      // RS256 or ES256
      let keyObj = this.publicKey;
      if (!keyObj && this.jwksStore && header.kid) {
        keyObj = await this.jwksStore.getKey(header.kid);
        if (!keyObj) {
          return {
            valid: false,
            error: {
              code: 'UNKNOWN_KID',
              message: `Unknown key identifier (kid: "${header.kid}") in JWKS`,
            },
          };
        }
      }

      if (!keyObj) {
        return {
          valid: false,
          error: {
            code: 'ALGORITHM_CONFUSION',
            message: `Public key for algorithm "${alg}" could not be resolved`,
          },
        };
      }

      // Strict asymmetric key type check against algorithm
      if (alg === 'RS256' && keyObj.asymmetricKeyType !== 'rsa') {
        return {
          valid: false,
          error: {
            code: 'ALGORITHM_CONFUSION',
            message: `Algorithm RS256 requires RSA key, received ${keyObj.asymmetricKeyType}`,
          },
        };
      }

      if (alg === 'ES256' && keyObj.asymmetricKeyType !== 'ec') {
        return {
          valid: false,
          error: {
            code: 'ALGORITHM_CONFUSION',
            message: `Algorithm ES256 requires EC key, received ${keyObj.asymmetricKeyType}`,
          },
        };
      }

      verificationKey = keyObj;
    }

    // 4. Verify Signature
    const dataBuf = Buffer.from(signingInput, 'utf8');

    if (alg === 'HS256') {
      const hmac = crypto.createHmac('sha256', verificationKey as Buffer).update(dataBuf).digest();
      if (
        signature.length !== hmac.length ||
        !crypto.timingSafeEqual(signature, hmac)
      ) {
        return {
          valid: false,
          error: { code: 'INVALID_SIGNATURE', message: 'HS256 HMAC signature verification failed' },
        };
      }
    } else if (alg === 'RS256') {
      const valid = crypto.verify(
        'RSA-SHA256',
        dataBuf,
        verificationKey as crypto.KeyObject,
        signature
      );
      if (!valid) {
        return {
          valid: false,
          error: { code: 'INVALID_SIGNATURE', message: 'RS256 signature verification failed' },
        };
      }
    } else if (alg === 'ES256') {
      const valid = crypto.verify(
        'SHA256',
        dataBuf,
        { key: verificationKey as crypto.KeyObject, dsaEncoding: 'ieee-p1363' },
        signature
      );
      if (!valid) {
        return {
          valid: false,
          error: { code: 'INVALID_SIGNATURE', message: 'ES256 signature verification failed' },
        };
      }
    }

    // 5. Validate Claims (exp, nbf, iss, aud) with Clock Skew
    const nowSec = Math.floor(this.clock.now() / 1000);

    // exp
    if (claims.exp !== undefined) {
      if (typeof claims.exp !== 'number' || isNaN(claims.exp)) {
        return {
          valid: false,
          error: { code: 'MALFORMED_TOKEN', message: 'Claim "exp" must be a numeric timestamp' },
        };
      }
      if (nowSec > claims.exp + this.clockSkewSeconds) {
        return {
          valid: false,
          error: { code: 'TOKEN_EXPIRED', message: `Token expired at ${claims.exp} (now: ${nowSec})` },
        };
      }
    }

    // nbf
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || isNaN(claims.nbf)) {
        return {
          valid: false,
          error: { code: 'MALFORMED_TOKEN', message: 'Claim "nbf" must be a numeric timestamp' },
        };
      }
      if (nowSec < claims.nbf - this.clockSkewSeconds) {
        return {
          valid: false,
          error: {
            code: 'TOKEN_NOT_YET_VALID',
            message: `Token not valid before ${claims.nbf} (now: ${nowSec})`,
          },
        };
      }
    }

    // iss
    if (this.issuer !== undefined && claims.iss !== this.issuer) {
      return {
        valid: false,
        error: {
          code: 'INVALID_ISSUER',
          message: `Expected issuer "${this.issuer}", got "${claims.iss}"`,
        },
      };
    }

    // aud
    if (this.audience !== undefined) {
      const expectedAuds = Array.isArray(this.audience) ? this.audience : [this.audience];
      const tokenAuds = Array.isArray(claims.aud)
        ? claims.aud
        : typeof claims.aud === 'string'
        ? [claims.aud]
        : [];

      const hasMatch = expectedAuds.some((aud) => tokenAuds.includes(aud));
      if (!hasMatch) {
        return {
          valid: false,
          error: {
            code: 'INVALID_AUDIENCE',
            message: `Token audience "${claims.aud}" does not match required audience`,
          },
        };
      }
    }

    return {
      valid: true,
      claims,
      header,
    };
  }
}
