import crypto from 'node:crypto';
import { Clock } from '../util/clock.js';

export interface ApiKeyRecord {
  id: string;
  key?: string; // Raw key (will be hashed upon loading)
  hashedKey?: string | Buffer; // Pre-hashed SHA-256 hex or buffer
  tenantId?: string;
  roles?: string[];
  expiresAt?: number; // epoch ms
  revoked?: boolean;
}

export interface InternalApiKeyRecord {
  id: string;
  hash: Buffer;
  tenantId?: string;
  roles?: string[];
  expiresAt?: number;
  revoked?: boolean;
}

export interface ApiKeyAuthConfig {
  enabled?: boolean;
  headerName?: string; // default: 'x-api-key'
  allowBearer?: boolean; // default: true (also accepts Authorization: Bearer <key> or ApiKey <key>)
  keys?: readonly ApiKeyRecord[];
}

export interface ApiKeyAuthResult {
  authenticated: boolean;
  status?: 401 | 403;
  code?: 'MISSING_API_KEY' | 'INVALID_API_KEY' | 'EXPIRED_API_KEY' | 'REVOKED_API_KEY';
  message?: string;
  keyId?: string;
  tenantId?: string;
  roles?: string[];
}

export class ApiKeyValidator {
  private readonly keys: InternalApiKeyRecord[] = [];
  private readonly headerName: string;
  private readonly allowBearer: boolean;

  constructor(config: ApiKeyAuthConfig = {}) {
    this.headerName = (config.headerName || 'x-api-key').toLowerCase();
    this.allowBearer = config.allowBearer ?? true;

    if (config.keys) {
      for (const k of config.keys) {
        let hash: Buffer;
        if (k.hashedKey) {
          hash = Buffer.isBuffer(k.hashedKey)
            ? k.hashedKey
            : Buffer.from(k.hashedKey, 'hex');
        } else if (k.key) {
          hash = crypto.createHash('sha256').update(k.key).digest();
        } else {
          continue;
        }

        if (hash.length !== 32) {
          throw new Error(`Invalid SHA-256 hash length for API key "${k.id}"`);
        }

        this.keys.push({
          id: k.id,
          hash,
          tenantId: k.tenantId,
          roles: k.roles,
          expiresAt: k.expiresAt,
          revoked: k.revoked,
        });
      }
    }
  }

  /**
   * Extracts API key candidate strictly from headers (never query parameters).
   */
  public extractKey(headers: Record<string, string | string[] | undefined>): string | null {
    // 1. Check custom header (e.g. x-api-key)
    const customHeader = headers[this.headerName];
    if (customHeader) {
      const val = Array.isArray(customHeader) ? customHeader[0] : customHeader;
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }

    // 2. Check Authorization header if enabled
    if (this.allowBearer) {
      const auth = headers['authorization'];
      if (auth) {
        const val = Array.isArray(auth) ? auth[0] : auth;
        if (typeof val === 'string') {
          const parts = val.trim().split(/\s+/);
          if (parts.length === 2) {
            const scheme = parts[0].toLowerCase();
            if (scheme === 'bearer' || scheme === 'apikey') {
              return parts[1];
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Authenticates the request using constant-time hash comparison against configured keys.
   */
  public authenticate(
    headers: Record<string, string | string[] | undefined>,
    clock?: Clock
  ): ApiKeyAuthResult {
    const candidateKey = this.extractKey(headers);
    if (!candidateKey) {
      return {
        authenticated: false,
        status: 401,
        code: 'MISSING_API_KEY',
        message: 'API key is required in request headers',
      };
    }

    // Compute constant-time candidate SHA-256 hash
    const candidateHash = crypto.createHash('sha256').update(candidateKey).digest();
    const nowMs = clock ? clock.now() : Date.now();

    let matchedRecord: InternalApiKeyRecord | null = null;

    // Constant-time check across all stored keys to mitigate timing side-channels
    for (const record of this.keys) {
      if (crypto.timingSafeEqual(candidateHash, record.hash)) {
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord) {
      return {
        authenticated: false,
        status: 401,
        code: 'INVALID_API_KEY',
        message: 'Invalid API key provided',
      };
    }

    if (matchedRecord.revoked) {
      return {
        authenticated: false,
        status: 403,
        code: 'REVOKED_API_KEY',
        message: 'API key has been revoked',
      };
    }

    if (matchedRecord.expiresAt !== undefined && nowMs > matchedRecord.expiresAt) {
      return {
        authenticated: false,
        status: 401,
        code: 'EXPIRED_API_KEY',
        message: 'API key has expired',
      };
    }

    return {
      authenticated: true,
      keyId: matchedRecord.id,
      tenantId: matchedRecord.tenantId,
      roles: matchedRecord.roles,
    };
  }
}
