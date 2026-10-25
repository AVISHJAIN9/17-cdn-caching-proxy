import { LifetimeSource } from './lifetime.js';
import { EntityTag } from './etag.js';

export interface CacheEntry {
  keyHash: string;
  keyString: string;
  originId: string;
  namespace?: string;
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  size: number;
  storedAt: number;
  hitCount: number;
  lastAccessedAt: number;

  // RFC 9111 Freshness Metadata
  requestTimeMs: number;
  responseTimeMs: number;
  dateValueMs: number;
  ageValueSeconds: number;
  freshnessLifetimeMs: number;
  lifetimeSource: LifetimeSource;
  dateSource?: 'origin' | 'proxy_added';
  etag?: EntityTag;
  lastModifiedMs?: number;

  // Batch 7 Revalidation Metadata
  etagRaw?: string;
  lastModifiedRaw?: string;
  version?: number;
  refreshedAt?: number;
  revalidationCount?: number;
}

export interface CacheStats {
  entries: number;
  totalBytes: number;
  hits: number;
  misses: number;
  bypasses: number;
  stores: number;
  storeSkipped: number;
  notModified: number;
  revalidations: number;
  revalidatedNotModified: number;
  revalidatedReplaced: number;
  revalidateFailed: number;
  revalidateSuperseded: number;
  validatorMismatches: number;
}

export interface TenantQuota {
  maxTotalBytes?: number;
  maxEntries?: number;
}

export interface EvictionEvent {
  reason: 'lru' | 'lfu' | 'slru' | 'ttl' | 'size' | 'quota';
  tenant?: string;
  bytes: number;
  count?: number;
  keyHash?: string;
}

export interface CacheStoreLimits {
  maxObjectBytes?: number; // default 5 MB
  maxTotalBytes?: number; // default 256 MB
  maxEntries?: number; // default 10000
  tenantQuotas?: Record<string, TenantQuota>;
  evictionPolicy?: any; // EvictionPolicy | 'lru' | 'lfu' | 'none'
  isProtectedFromEviction?: (keyHash: string) => boolean;
  onEvict?: (event: EvictionEvent) => void;
}

export interface CacheStore {
  readonly maxObjectBytes?: number;
  get(keyHash: string): CacheEntry | undefined;
  set(entry: CacheEntry): boolean;
  delete(keyHash: string): boolean;
  stats(): CacheStats;
  recordHit(keyHash?: string, now?: number): void;
  recordMiss(): void;
  recordBypass(): void;
  recordNotModified?(): void;
  recordRevalidation?(outcome: 'not_modified' | 'replaced' | 'failed' | 'superseded' | 'mismatch' | 'stale_fallback' | string, meta?: { type?: string; tenant?: string }): void;
  clear(): void;
  getTenantStats?(tenant: string): { totalBytes: number; entries: number };
  setTenantQuota?(tenant: string, quota: TenantQuota): void;
  getTenantQuota?(tenant: string): TenantQuota | undefined;
  purgeNamespace?(tenant: string): number;
  setOnEvict?(callback: (event: EvictionEvent) => void): void;
  setOnRevalidate?(callback: (event: { outcome: string; type?: string; tenant?: string }) => void): void;
}
