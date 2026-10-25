import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CacheStore, CacheEntry, CacheStats, CacheStoreLimits, TenantQuota } from './store.js';
import { MetadataIndex, EntryMetadata } from './metadata-index.js';
import { EvictionPolicy } from './eviction/policy.js';
import { LruPolicy } from './eviction/lru.js';
import { LfuPolicy } from './eviction/lfu.js';
import { SlruPolicy } from './eviction/slru.js';
import { isTtlEvictable } from './eviction/ttl.js';

export interface DiskStoreOptions extends CacheStoreLimits {
  dirPath?: string;
  diskPath?: string;
  isolateTenantPaths?: boolean;
}

const MAGIC = Buffer.from('CDNCACHE'); // 8 bytes
const HEADER_LEN = 48; // 8 magic + 4 metaLen + 4 bodyLen + 32 sha256

export class DiskStore implements CacheStore {
  public readonly dirPath: string;
  public readonly maxObjectBytes: number;
  public readonly maxTotalBytes: number;
  public readonly maxEntries: number;
  public readonly isolateTenantPaths: boolean;

  private readonly metadataIndex: MetadataIndex = new MetadataIndex();
  private evictionPolicy?: EvictionPolicy;
  private isProtectedFromEviction?: (keyHash: string) => boolean;
  private tenantQuotas: Map<string, TenantQuota> = new Map();

  private totalStoredBytes = 0;
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

  constructor(options: DiskStoreOptions) {
    this.dirPath = options.dirPath ?? options.diskPath ?? '';
    this.maxObjectBytes = options.maxObjectBytes ?? 5 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 10000;
    this.isolateTenantPaths = options.isolateTenantPaths ?? false;

    if (options.tenantQuotas) {
      for (const [tenant, quota] of Object.entries(options.tenantQuotas)) {
        this.tenantQuotas.set(tenant, { ...quota });
      }
    }

    if (options.evictionPolicy === 'lru') {
      this.evictionPolicy = new LruPolicy();
    } else if (options.evictionPolicy === 'lfu') {
      this.evictionPolicy = new LfuPolicy();
    } else if (options.evictionPolicy === 'slru') {
      this.evictionPolicy = new SlruPolicy({ maxEntries: this.maxEntries });
    } else if (typeof options.evictionPolicy === 'object' && options.evictionPolicy !== null) {
      this.evictionPolicy = options.evictionPolicy;
    }
    this.isProtectedFromEviction = options.isProtectedFromEviction;

    // Ensure directory exists
    try {
      fs.mkdirSync(this.dirPath, { recursive: true });
    } catch {}

    // Clean up any orphan temp files
    this.cleanOrphanTempFiles();

    // Rebuild metadata index from disk
    this.rebuildIndex();
  }

  public rebuildIndex(): void {
    if (!fs.existsSync(this.dirPath)) return;
    const scanDir = (dir: string): string[] => {
      const files: string[] = [];
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              files.push(...scanDir(full));
            } else if (stat.isFile() && item.endsWith('.cache')) {
              files.push(full);
            }
          } catch {}
        }
      } catch {}
      return files;
    };

    const cacheFiles = scanDir(this.dirPath);
    const validEntries: EntryMetadata[] = [];

    for (const fullPath of cacheFiles) {
      let fileBuf: Buffer;
      try {
        fileBuf = fs.readFileSync(fullPath);
      } catch {
        continue;
      }

      if (fileBuf.length < HEADER_LEN) {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }

      if (!fileBuf.subarray(0, 8).equals(MAGIC)) {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }

      const metaLen = fileBuf.readUInt32BE(8);
      const bodyLen = fileBuf.readUInt32BE(12);
      const expectedChecksum = fileBuf.subarray(16, 48);

      if (fileBuf.length !== HEADER_LEN + metaLen + bodyLen) {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }

      const metaBuf = fileBuf.subarray(HEADER_LEN, HEADER_LEN + metaLen);
      const bodyBuf = fileBuf.subarray(HEADER_LEN + metaLen, HEADER_LEN + metaLen + bodyLen);

      const actualChecksum = crypto
        .createHash('sha256')
        .update(metaBuf)
        .update(bodyBuf)
        .digest();

      if (!actualChecksum.equals(expectedChecksum)) {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }

      let parsedMeta: EntryMetadata;
      try {
        parsedMeta = JSON.parse(metaBuf.toString('utf8'));
      } catch {
        try { fs.unlinkSync(fullPath); } catch {}
        continue;
      }

      validEntries.push(parsedMeta);
    }

    // Sort valid entries chronologically by lastAccessedAt
    validEntries.sort((a, b) => (a.lastAccessedAt ?? a.storedAt) - (b.lastAccessedAt ?? b.storedAt));

    for (const parsedMeta of validEntries) {
      this.metadataIndex.set(parsedMeta);
      this.totalStoredBytes += parsedMeta.size;
      this.nextVersion = Math.max(this.nextVersion, parsedMeta.version ?? 0);
      this.evictionPolicy?.onInsert(parsedMeta.keyHash, {
        keyHash: parsedMeta.keyHash,
        size: parsedMeta.size,
        lastAccessedAt: parsedMeta.lastAccessedAt,
        hitCount: parsedMeta.hitCount,
      });
    }
  }

  private keyToFilename(keyHash: string): string {
    return `${Buffer.from(keyHash, 'utf8').toString('hex')}.cache`;
  }

  public getFilePath(keyHash: string, namespace?: string): string {
    const ns = namespace ?? this.metadataIndex.get(keyHash)?.namespace;
    if (this.isolateTenantPaths && ns) {
      return path.join(this.dirPath, ns, this.keyToFilename(keyHash));
    }
    return path.join(this.dirPath, this.keyToFilename(keyHash));
  }

  private cleanOrphanTempFiles(): void {
    const cleanDir = (dir: string): void => {
      try {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              cleanDir(full);
            } else if (stat.isFile() && (item.endsWith('.tmp') || item.includes('.tmp.'))) {
              try { fs.unlinkSync(full); } catch {}
            }
          } catch {}
        }
      } catch {}
    };
    cleanDir(this.dirPath);
  }

  setEvictionPolicy(policy: EvictionPolicy | 'lru' | 'lfu' | 'slru' | 'none'): void {
    if (policy === 'lru') {
      this.evictionPolicy = new LruPolicy();
    } else if (policy === 'lfu') {
      this.evictionPolicy = new LfuPolicy();
    } else if (policy === 'slru') {
      this.evictionPolicy = new SlruPolicy({ maxEntries: this.maxEntries });
    } else if (policy === 'none') {
      this.evictionPolicy = undefined;
    } else {
      this.evictionPolicy = policy;
    }

    if (this.evictionPolicy) {
      for (const [keyHash, meta] of this.metadataIndex.entries()) {
        this.evictionPolicy.onInsert(keyHash, {
          keyHash,
          size: meta.size,
          lastAccessedAt: meta.lastAccessedAt,
          hitCount: meta.hitCount,
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

  getMetadataIndex(): MetadataIndex {
    return this.metadataIndex;
  }

  get(keyHash: string): CacheEntry | undefined {
    const meta = this.metadataIndex.get(keyHash);
    const targetPath = this.getFilePath(keyHash);

    if (!fs.existsSync(targetPath)) {
      if (meta) {
        this.metadataIndex.delete(keyHash);
        this.totalStoredBytes -= meta.size;
      }
      return undefined;
    }

    let fileBuf: Buffer;
    try {
      fileBuf = fs.readFileSync(targetPath);
    } catch {
      return undefined;
    }

    if (fileBuf.length < HEADER_LEN) {
      // Corrupt or truncated header
      this.removeCorruptFile(keyHash, targetPath, meta?.size ?? 0);
      return undefined;
    }

    // Verify magic
    if (!fileBuf.subarray(0, 8).equals(MAGIC)) {
      this.removeCorruptFile(keyHash, targetPath, meta?.size ?? 0);
      return undefined;
    }

    const metaLen = fileBuf.readUInt32BE(8);
    const bodyLen = fileBuf.readUInt32BE(12);
    const expectedChecksum = fileBuf.subarray(16, 48);

    if (fileBuf.length !== HEADER_LEN + metaLen + bodyLen) {
      // Truncated payload
      this.removeCorruptFile(keyHash, targetPath, meta?.size ?? 0);
      return undefined;
    }

    const metaBuf = fileBuf.subarray(HEADER_LEN, HEADER_LEN + metaLen);
    const bodyBuf = fileBuf.subarray(HEADER_LEN + metaLen, HEADER_LEN + metaLen + bodyLen);

    // Compute checksum
    const actualChecksum = crypto
      .createHash('sha256')
      .update(metaBuf)
      .update(bodyBuf)
      .digest();

    if (!actualChecksum.equals(expectedChecksum)) {
      // Flipped byte or checksum mismatch
      this.removeCorruptFile(keyHash, targetPath, meta?.size ?? 0);
      return undefined;
    }

    let parsedMeta: EntryMetadata;
    try {
      parsedMeta = JSON.parse(metaBuf.toString('utf8'));
    } catch {
      this.removeCorruptFile(keyHash, targetPath, meta?.size ?? 0);
      return undefined;
    }

    // Return CacheEntry
    return {
      ...parsedMeta,
      hitCount: meta?.hitCount ?? parsedMeta.hitCount,
      lastAccessedAt: meta?.lastAccessedAt ?? parsedMeta.lastAccessedAt,
      headers: { ...parsedMeta.headers },
      body: Buffer.from(bodyBuf),
    };
  }

  private removeCorruptFile(keyHash: string, targetPath: string, size: number): void {
    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    } catch {}
    this.metadataIndex.delete(keyHash);
    this.evictionPolicy?.onRemove(keyHash);
    this.totalStoredBytes = Math.max(0, this.totalStoredBytes - size);
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

    const existingMeta = this.metadataIndex.get(entry.keyHash);
    const existingSize = existingMeta ? existingMeta.size : 0;
    let projectedBytes = this.totalStoredBytes - existingSize + entrySize;
    let projectedEntries = existingMeta ? this.metadataIndex.size : this.metadataIndex.size + 1;

    // 3a. Tenant quota eviction: a tenant over quota evicts its OWN entries only
    if (tenantQuota) {
      const tenantStats = this.metadataIndex.getNamespaceStats(tenant);
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

        const victimMeta = this.metadataIndex.get(victim);
        const victimSize = victimMeta?.size ?? 0;
        this.delete(victim);
        projectedTenantBytes -= victimSize;
        projectedTenantEntries--;
        projectedBytes -= victimSize;
        projectedEntries--;
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
          break; // All candidates protected
        }

        const victimMeta = this.metadataIndex.get(victim);
        const victimSize = victimMeta?.size ?? 0;
        this.delete(victim);
        projectedBytes -= victimSize;
        projectedEntries--;
      }
    }

    // 4. Enforce capacity limits: if still over budget, refuse cleanly
    if (projectedBytes > this.maxTotalBytes || projectedEntries > this.maxEntries) {
      this.storeSkippedCount++;
      console.warn(
        `cache_full: disk store capacity reached (totalBytes=${this.totalStoredBytes}, entries=${this.metadataIndex.size}); skipping store`
      );
      return false;
    }

    // 5. Serialize entry to disk file atomically via temp file + rename
    const metaRecord: EntryMetadata = {
      keyHash: entry.keyHash,
      keyString: entry.keyString,
      originId: entry.originId,
      namespace: entry.namespace ?? 'default',
      status: entry.status,
      statusMessage: entry.statusMessage,
      headers: { ...entry.headers },
      size: entrySize,
      storedAt: entry.storedAt,
      lastAccessedAt: entry.lastAccessedAt,
      hitCount: entry.hitCount,
      requestTimeMs: entry.requestTimeMs,
      responseTimeMs: entry.responseTimeMs,
      dateValueMs: entry.dateValueMs,
      ageValueSeconds: entry.ageValueSeconds,
      freshnessLifetimeMs: entry.freshnessLifetimeMs,
      lifetimeSource: entry.lifetimeSource,
      dateSource: entry.dateSource,
      etag: entry.etag,
      lastModifiedMs: entry.lastModifiedMs,
      etagRaw: entry.etagRaw,
      lastModifiedRaw: entry.lastModifiedRaw,
      version: ++this.nextVersion,
      refreshedAt: entry.refreshedAt,
      revalidationCount: entry.revalidationCount,
    };

    const metaBuf = Buffer.from(JSON.stringify(metaRecord), 'utf8');
    const bodyBuf = Buffer.from(entry.body);
    const checksum = crypto
      .createHash('sha256')
      .update(metaBuf)
      .update(bodyBuf)
      .digest();

    const fileBuf = Buffer.allocUnsafe(HEADER_LEN + metaBuf.length + bodyBuf.length);
    MAGIC.copy(fileBuf, 0);
    fileBuf.writeUInt32BE(metaBuf.length, 8);
    fileBuf.writeUInt32BE(bodyBuf.length, 12);
    checksum.copy(fileBuf, 16);
    metaBuf.copy(fileBuf, HEADER_LEN);
    bodyBuf.copy(fileBuf, HEADER_LEN + metaBuf.length);

    const ns = metaRecord.namespace ?? 'default';
    const targetDir = this.isolateTenantPaths ? path.join(this.dirPath, ns) : this.dirPath;
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {}

    const targetPath = this.getFilePath(entry.keyHash, ns);
    const tempFile = path.join(
      targetDir,
      `.${this.keyToFilename(entry.keyHash)}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );

    try {
      fs.writeFileSync(tempFile, fileBuf);
      fs.renameSync(tempFile, targetPath);
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
      this.storeSkippedCount++;
      return false;
    }

    // Update in-memory index and size accounting
    this.totalStoredBytes = this.totalStoredBytes - existingSize + entrySize;
    this.metadataIndex.set(metaRecord);
    this.evictionPolicy?.onInsert(entry.keyHash, {
      keyHash: entry.keyHash,
      size: entrySize,
      lastAccessedAt: metaRecord.lastAccessedAt,
      hitCount: metaRecord.hitCount,
    });
    this.storesCount++;
    entry.version = metaRecord.version;
    return true;
  }

  delete(keyHash: string): boolean {
    const meta = this.metadataIndex.get(keyHash);
    const targetPath = this.getFilePath(keyHash, meta?.namespace);
    let deletedFile = false;

    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
        deletedFile = true;
      }
    } catch {}

    const deletedIndex = this.metadataIndex.delete(keyHash);
    if (meta) {
      this.totalStoredBytes = Math.max(0, this.totalStoredBytes - meta.size);
    }
    this.evictionPolicy?.onRemove(keyHash);
    return deletedFile || deletedIndex;
  }

  purgeNamespace(tenant: string): number {
    const entries = this.metadataIndex.getByNamespace(tenant);
    let count = 0;
    for (const meta of entries) {
      if (this.delete(meta.keyHash)) {
        count++;
      }
    }
    if (this.isolateTenantPaths) {
      try {
        const tenantDir = path.join(this.dirPath, tenant);
        if (fs.existsSync(tenantDir)) {
          fs.rmSync(tenantDir, { recursive: true, force: true });
        }
      } catch {}
    }
    return count;
  }

  sumLiveBytes(): number {
    let sum = 0;
    for (const meta of this.metadataIndex.values()) {
      sum += meta.size;
    }
    return sum;
  }

  stats(): CacheStats {
    return {
      entries: this.metadataIndex.size,
      totalBytes: this.totalStoredBytes,
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

  recordRevalidation(outcome: 'not_modified' | 'replaced' | 'failed' | 'superseded' | 'mismatch'): void {
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
  }

  evictExpired(nowMs?: number): { evictedCount: number; evictedBytes: number; evictedKeys: string[] } {
    const now = nowMs ?? Date.now();
    const evictedKeys: string[] = [];
    let evictedBytes = 0;

    for (const [keyHash, meta] of Array.from(this.metadataIndex.entries())) {
      if (isTtlEvictable(meta as any, now)) {
        const size = meta.size;
        if (this.delete(keyHash)) {
          evictedKeys.push(keyHash);
          evictedBytes += size;
        }
      }
    }

    return {
      evictedCount: evictedKeys.length,
      evictedBytes,
      evictedKeys,
    };
  }

  getAllEntries(): Iterable<[string, CacheEntry]> {
    const entries: [string, CacheEntry][] = [];
    for (const [keyHash] of this.metadataIndex.entries()) {
      const entry = this.get(keyHash);
      if (entry) {
        entries.push([keyHash, entry]);
      }
    }
    return entries;
  }

  clear(): void {
    for (const keyHash of Array.from(this.metadataIndex.keys())) {
      this.delete(keyHash);
    }
    this.cleanOrphanTempFiles();
    this.metadataIndex.clear();
    this.totalStoredBytes = 0;
    this.evictionPolicy?.clear();
    this.notModifiedCount = 0;
    this.revalidationsCount = 0;
    this.revalidatedNotModifiedCount = 0;
    this.revalidatedReplacedCount = 0;
    this.revalidateFailedCount = 0;
    this.revalidateSupersededCount = 0;
    this.validatorMismatchesCount = 0;
  }
}
