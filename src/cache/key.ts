import crypto from 'node:crypto';

export interface CacheKeyInput {
  namespace?: string;
  originId: string;
  method: string;
  host: string;
  normalizedPath: string;
  normalizedQuery: string;
  includeHost?: boolean;
}

export interface CacheKey {
  keyString: string;
  keyHash: string;
}

/**
 * Normalizes host for cache key: lowercases, removes default ports (:80, :443).
 */
export function normalizeHostForKey(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.replace(/:(80|443)$/, '');
}

/**
 * Pure cache key generation:
 * keyString = JSON.stringify(["v1", namespace, originId, method, host, path, query])
 * keyHash = sha256 hex digest of keyString.
 */
export function generateCacheKey(input: CacheKeyInput): CacheKey {
  const namespace = input.namespace ?? 'default';
  const originId = input.originId;
  const method = input.method.toUpperCase();
  const includeHost = input.includeHost ?? true;
  const host = includeHost ? normalizeHostForKey(input.host) : '';
  const path = input.normalizedPath;
  const query = input.normalizedQuery;

  const keyArray = ['v1', namespace, originId, method, host, path, query];
  const keyString = JSON.stringify(keyArray);
  const keyHash = crypto.createHash('sha256').update(keyString).digest('hex');

  return {
    keyString,
    keyHash,
  };
}
