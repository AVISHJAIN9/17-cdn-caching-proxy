import { LifetimeSource } from './lifetime.js';
import { EntityTag } from './etag.js';

export interface EntryMetadata {
  keyHash: string;
  keyString: string;
  originId: string;
  namespace?: string;
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  size: number;
  storedAt: number;
  lastAccessedAt: number;
  hitCount: number;

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

  // Revalidation Metadata
  etagRaw?: string;
  lastModifiedRaw?: string;
  version?: number;
  refreshedAt?: number;
  revalidationCount?: number;
}

/**
 * MetadataIndex provides O(1) hash map indexing from keyHash to EntryMetadata.
 * Tracks size, status, headers, timestamps, hit counts, and namespace without linear scans.
 */
export class MetadataIndex {
  private readonly map: Map<string, EntryMetadata> = new Map();

  get(keyHash: string): EntryMetadata | undefined {
    return this.map.get(keyHash);
  }

  has(keyHash: string): boolean {
    return this.map.has(keyHash);
  }

  set(metadata: EntryMetadata): void {
    this.map.set(metadata.keyHash, {
      ...metadata,
      namespace: metadata.namespace ?? 'default',
      headers: { ...metadata.headers },
    });
  }

  delete(keyHash: string): boolean {
    return this.map.delete(keyHash);
  }

  recordHit(keyHash: string, accessedAt?: number): EntryMetadata | undefined {
    const meta = this.map.get(keyHash);
    if (!meta) return undefined;
    meta.hitCount++;
    meta.lastAccessedAt = accessedAt ?? Date.now();
    return meta;
  }

  getUnderlyingMap(): Map<string, EntryMetadata> {
    return this.map;
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<EntryMetadata> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, EntryMetadata]> {
    return this.map.entries();
  }

  clear(): void {
    this.map.clear();
  }

  getByNamespace(namespace: string): EntryMetadata[] {
    const results: EntryMetadata[] = [];
    for (const meta of this.map.values()) {
      if ((meta.namespace ?? 'default') === namespace) {
        results.push(meta);
      }
    }
    return results;
  }

  getNamespaceStats(namespace: string): { entries: number; totalBytes: number } {
    let entries = 0;
    let totalBytes = 0;
    for (const meta of this.map.values()) {
      if ((meta.namespace ?? 'default') === namespace) {
        entries++;
        totalBytes += meta.size;
      }
    }
    return { entries, totalBytes };
  }
}
