import { CacheStore, CacheEntry, CacheStats, CacheStoreLimits, TenantQuota, EvictionEvent } from './store.js';
import { MetadataIndex, EntryMetadata } from './metadata-index.js';
import { ObjectStore } from './object-store.js';
import { isTtlEvictable } from './eviction/ttl.js';
import { EvictionPolicy } from './eviction/policy.js';
import { LruPolicy } from './eviction/lru.js';
import { LfuPolicy } from './eviction/lfu.js';
import { SlruPolicy } from './eviction/slru.js';

export class MemoryStore implements CacheStore {
  private entries: Map<string, CacheEntry> = new Map();
  private readonly metadataIndex: MetadataIndex = new MetadataIndex();
  private readonly objectStore: ObjectStore = new ObjectStore();
  private evictionPolicy?: EvictionPolicy;
  private isProtectedFromEviction?: (keyHash: string) => boolean;
  private tenantQuotas: Map<string, TenantQuota> = new Map();
  private onEvict?: (event: EvictionEvent) => void;
  private onRevalidate?: (event: { outcome: string; type?: string; tenant?: string }) => void;
  private evictionPolicyName: 'lru' | 'lfu' | 'slru' | 'size' = 'lru';

  private hitsCount = 0;
  private missesCount = 0;
  private bypassesCount = 0;
  private storesCount = 0;
  private storeSkippedCount = 0;
  private notModifiedCount = 0;
  private revalidationsCount = 0;
  private revalidatedNotModifiedCount = 0;
  private revalidatedReplacedCount = 0;
  private revalidateFailedCount = 0;
  private revalidateSupersededCount = 0;
  private validatorMismatchesCount = 0;
  private nextVersion = 0;

  public readonly maxObjectBytes: number;
  public readonly maxTotalBytes: number;
  public readonly maxEntries: number;

  constructor(limits: CacheStoreLimits = {}) {
    this.maxObjectBytes = limits.maxObjectBytes ?? 5 * 1024 * 1024; // 5 MB
    this.maxTotalBytes = limits.maxTotalBytes ?? 256 * 1024 * 1024; // 256 MB
    this.maxEntries = limits.maxEntries ?? 10000;

    if (limits.tenantQuotas) {
      for (const [tenant, quota] of Object.entries(limits.tenantQuotas)) {
        this.tenantQuotas.set(tenant, { ...quota });
      }
    }

    this.onEvict = limits.onEvict;
    if (limits.evictionPolicy === 'lru') {
      this.evictionPolicy = new LruPolicy();
      this.evictionPolicyName = 'lru';
    } else if (limits.evictionPolicy === 'lfu') {
      this.evictionPolicy = new LfuPolicy();
      this.evictionPolicyName = 'lfu';
    } else if (limits.evictionPolicy === 'slru') {
      this.evictionPolicy = new SlruPolicy({ maxEntries: this.maxEntries });
      this.evictionPolicyName = 'slru';
    } else if (typeof limits.evictionPolicy === 'object' && limits.evictionPolicy !== null) {
      this.evictionPolicy = limits.evictionPolicy;
      this.evictionPolicyName = 'lru';
    }
    this.isProtectedFromEviction = limits.isProtectedFromEviction;
  }

  setOnEvict(callback: (event: EvictionEvent) => void): void {
    this.onEvict = callback;
  }

  setOnRevalidate(callback: (event: { outcome: string; type?: string; tenant?: string }) => void): void {
    this.onRevalidate = callback;
  }

  setEvictionPolicy(policy: EvictionPolicy | 'lru' | 'lfu' | 'slru' | 'none'): void {
    if (policy === 'lru') {
      this.evictionPolicy = new LruPolicy();
      this.evictionPolicyName = 'lru';
    } else if (policy === 'lfu') {
      this.evictionPolicy = new LfuPolicy();
      this.evictionPolicyName = 'lfu';
    } else if (policy === 'slru') {
      this.evictionPolicy = new SlruPolicy({ maxEntries: this.maxEntries });
      this.evictionPolicyName = 'slru';
    } else if (policy === 'none') {
      this.evictionPolicy = undefined;
    } else {
      this.evictionPolicy = policy;
      this.evictionPolicyName = 'lru';
    }

    if (this.evictionPolicy) {
      for (const [keyHash, entry] of this.entries.entries()) {
        this.evictionPolicy.onInsert(keyHash, {
          keyHash,
          size: entry.size,
          lastAccessedAt: entry.lastAccessedAt,
          hitCount: entry.hitCount,
        });
      }
    }
  }

  getEvictionPolicy(): EvictionPolicy | undefined {
    return this.evictionPolicy;
  }

  setProtectedPredicate(fn: (keyHash: string) => boolean): void {
    this.isProtectedFromEviction = fn;
  }

  getMetadataIndex(): MetadataIndex {
    return this.metadataIndex;
  }

  setTenantQuota(tenant: string, quota: TenantQuota): void {
    this.tenantQuotas.set(tenant, { ...quota });
  }

  getTenantQuota(tenant: string): TenantQuota | undefined {
    const q = this.tenantQuotas.get(tenant);
    return q ? { ...q } : undefined;
  }

  getTenantStats(tenant: string): { totalBytes: number; entries: number } {
    return this.metadataIndex.getNamespaceStats(tenant);
  }

  getObjectStore(): ObjectStore {
    return this.objectStore;
  }

  getAllEntries(): Iterable<[string, CacheEntry]> {
    return this.entries.entries();
  }

  get(keyHash: string): CacheEntry | undefined {
    const meta = this.metadataIndex.get(keyHash);
    const body = this.objectStore.get(keyHash);
    const entry = this.entries.get(keyHash);
    if (!meta || !body || !entry) return undefined;

    // Return defensive copy to guarantee immutability with fresh metadata and body
    return {
      ...entry,
      hitCount: meta.hitCount,
      lastAccessedAt: meta.lastAccessedAt,
      headers: { ...entry.headers },
      body,
    };
  }

  set(entry: CacheEntry): boolean {
    const entrySize = entry.size;

    // 1. Reject if object exceeds maxObjectBytes
    if (entrySize > this.maxObjectBytes) {
      this.storeSkippedCount++;
      console.warn(`cache_skip: object size (${entrySize} B) exceeds maxObjectBytes (${this.maxObjectBytes} B)`);
      return false;
    }

    // 2. Reject if single object exceeds maxTotalBytes (never evicts itself, cannot fit)
    if (entrySize > this.maxTotalBytes) {
      this.storeSkippedCount++;
      console.warn(`cache_skip: object size (${entrySize} B) exceeds maxTotalBytes (${this.maxTotalBytes} B)`);
      return false;
    }

    const tenant = entry.namespace ?? 'default';
    const tenantQuota = this.tenantQuotas.get(tenant);

    // 2b. Reject if object exceeds tenant maxTotalBytes
    if (tenantQuota?.maxTotalBytes !== undefined && entrySize > tenantQuota.maxTotalBytes) {
      this.storeSkippedCount++;
      console.warn(
        `cache_skip: object size (${entrySize} B) exceeds tenant '${tenant}' maxTotalBytes (${tenantQuota.maxTotalBytes} B)`
      );
      return false;
    }

    const existingSize = this.objectStore.sizeOf(entry.keyHash) ?? 0;
    let projectedBytes = this.objectStore.totalBytes - existingSize + entrySize;
    let projectedEntries = this.objectStore.has(entry.keyHash) ? this.objectStore.count : this.objectStore.count + 1;

    // 3a. Tenant quota eviction: a tenant over quota evicts its OWN entries only
    if (tenantQuota) {
      const tenantStats = this.metadataIndex.getNamespaceStats(tenant);
      const existingMeta = this.metadataIndex.get(entry.keyHash);
      const existingTenant = existingMeta ? (existingMeta.namespace ?? 'default') : null;
      const existingSizeForTenant = existingTenant === tenant ? existingMeta!.size : 0;
      let projectedTenantBytes = tenantStats.totalBytes - existingSizeForTenant + entrySize;
      let projectedTenantEntries = (existingTenant === tenant) ? tenantStats.entries : tenantStats.entries + 1;

      const isOverTenantQuota = () =>
        (tenantQuota.maxTotalBytes !== undefined && projectedTenantBytes > tenantQuota.maxTotalBytes) ||
        (tenantQuota.maxEntries !== undefined && projectedTenantEntries > tenantQuota.maxEntries);

      while (isOverTenantQuota()) {
        const victim = this.evictionPolicy
          ? this.evictionPolicy.pickVictim((k) => {
              if (k === entry.keyHash) return false;
              if (this.isProtectedFromEviction?.(k)) return false;
              const m = this.metadataIndex.get(k);
              return (m?.namespace ?? 'default') === tenant;
            })
          : this.metadataIndex.getByNamespace(tenant).find(
              (m) => m.keyHash !== entry.keyHash && (!this.isProtectedFromEviction || !this.isProtectedFromEviction(m.keyHash))
            )?.keyHash;

        if (!victim) {
          break; // No eligible victim for this tenant
        }

        const victimSize = this.objectStore.sizeOf(victim) ?? 0;
        this.delete(victim);
        projectedTenantBytes -= victimSize;
        projectedTenantEntries--;
        projectedBytes -= victimSize;
        projectedEntries--;
        this.onEvict?.({
          reason: 'quota',
          tenant,
          bytes: victimSize,
          count: 1,
          keyHash: victim,
        });
      }

      if (isOverTenantQuota()) {
        this.storeSkippedCount++;
        console.warn(`cache_full: tenant '${tenant}' quota exceeded; skipping store`);
        return false;
      }
    }

    // 3b. Evict via active eviction policy until under global budget
    if (this.evictionPolicy) {
      while (projectedBytes > this.maxTotalBytes || projectedEntries > this.maxEntries) {
        const victim = this.evictionPolicy.pickVictim((keyHash) => {
          if (keyHash === entry.keyHash) return false;
          if (this.isProtectedFromEviction?.(keyHash)) return false;
          return true;
        });

        if (!victim) {
          break; // All candidates protected or no victim available
        }

        const victimMeta = this.metadataIndex.get(victim);
        const victimTenant = victimMeta?.namespace ?? 'default';
        const victimSize = this.objectStore.sizeOf(victim) ?? 0;
        this.delete(victim);
        projectedBytes -= victimSize;
        projectedEntries--;
        this.onEvict?.({
          reason: this.evictionPolicyName,
          tenant: victimTenant,
          bytes: victimSize,
          count: 1,
          keyHash: victim,
        });
      }
    }

    // 4. Enforce capacity limits: if still over budget, refuse to store cleanly
    if (projectedBytes > this.maxTotalBytes || projectedEntries > this.maxEntries) {
      this.storeSkippedCount++;
      console.warn(
        `cache_full: memory store capacity reached (totalBytes=${this.objectStore.totalBytes}, entries=${this.objectStore.count}); skipping store`
      );
      return false;
    }

    // 5. Defensive copy for storage
    const storedEntry: CacheEntry = {
      ...entry,
      headers: { ...entry.headers },
      body: Buffer.from(entry.body),
      version: ++this.nextVersion,
    };

    this.metadataIndex.set(storedEntry as EntryMetadata);
    this.objectStore.put(entry.keyHash, storedEntry.body);
    this.entries.set(entry.keyHash, storedEntry);
    this.evictionPolicy?.onInsert(entry.keyHash, {
      keyHash: entry.keyHash,
      size: entrySize,
      lastAccessedAt: storedEntry.lastAccessedAt,
      hitCount: storedEntry.hitCount,
    });
    this.storesCount++;
    entry.version = storedEntry.version;
    return true;
  }

  delete(keyHash: string): boolean {
    const released = this.objectStore.delete(keyHash);
    this.metadataIndex.delete(keyHash);
    const deletedEntry = this.entries.delete(keyHash);
    this.evictionPolicy?.onRemove(keyHash);
    return released > 0 || deletedEntry;
  }

  stats(): CacheStats {
    return {
      entries: this.objectStore.count,
      totalBytes: this.objectStore.totalBytes,
      hits: this.hitsCount,
      misses: this.missesCount,
      bypasses: this.bypassesCount,
      stores: this.storesCount,
      storeSkipped: this.storeSkippedCount,
      notModified: this.notModifiedCount,
      revalidations: this.revalidationsCount,
      revalidatedNotModified: this.revalidatedNotModifiedCount,
      revalidatedReplaced: this.revalidatedReplacedCount,
      revalidateFailed: this.revalidateFailedCount,
      revalidateSuperseded: this.revalidateSupersededCount,
      validatorMismatches: this.validatorMismatchesCount,
    };
  }

  recordHit(keyHash?: string, now?: number): void {
    this.hitsCount++;
    if (keyHash) {
      this.metadataIndex.recordHit(keyHash, now);
      const entry = this.entries.get(keyHash);
      if (entry) {
        entry.hitCount++;
        entry.lastAccessedAt = now ?? Date.now();
      }
      this.evictionPolicy?.onAccess(keyHash, now);
    }
  }

  recordMiss(): void {
    this.missesCount++;
  }

  recordBypass(): void {
    this.bypassesCount++;
  }

  recordNotModified(): void {
    this.notModifiedCount++;
  }

  recordRevalidation(
    outcome: 'not_modified' | 'replaced' | 'failed' | 'superseded' | 'mismatch' | 'stale_fallback' | string,
    meta?: { type?: string; tenant?: string }
  ): void {
    this.revalidationsCount++;
    if (outcome === 'not_modified') {
      this.revalidatedNotModifiedCount++;
    } else if (outcome === 'replaced') {
      this.revalidatedReplacedCount++;
    } else if (outcome === 'failed') {
      this.revalidateFailedCount++;
    } else if (outcome === 'superseded') {
      this.revalidateSupersededCount++;
    } else if (outcome === 'mismatch') {
      this.validatorMismatchesCount++;
    }
    this.onRevalidate?.({ outcome, ...meta });
  }

  evictExpired(nowMs?: number): { evictedCount: number; evictedBytes: number; evictedKeys: string[] } {
    const now = nowMs ?? Date.now();
    const evictedKeys: string[] = [];
    let evictedBytes = 0;

    for (const [keyHash, entry] of Array.from(this.entries.entries())) {
      if (isTtlEvictable(entry, now)) {
        const size = entry.size;
        const tenant = (entry as any).namespace ?? 'default';
        if (this.delete(keyHash)) {
          evictedKeys.push(keyHash);
          evictedBytes += size;
          this.onEvict?.({
            reason: 'ttl',
            tenant,
            bytes: size,
            count: 1,
            keyHash,
          });
        }
      }
    }

    return {
      evictedCount: evictedKeys.length,
      evictedBytes,
      evictedKeys,
    };
  }

  clear(): void {
    this.entries.clear();
    this.metadataIndex.clear();
    this.objectStore.clear();
    this.evictionPolicy?.clear();
    this.notModifiedCount = 0;
    this.revalidationsCount = 0;
    this.revalidatedNotModifiedCount = 0;
    this.revalidatedReplacedCount = 0;
    this.revalidateFailedCount = 0;
    this.revalidateSupersededCount = 0;
    this.validatorMismatchesCount = 0;
  }

  purgeNamespace(tenant: string): number {
    const entries = this.metadataIndex.getByNamespace(tenant);
    let count = 0;
    for (const meta of entries) {
      if (this.delete(meta.keyHash)) {
        count++;
      }
    }
    return count;
  }
}

