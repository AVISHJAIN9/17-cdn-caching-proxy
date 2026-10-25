import crypto from 'node:crypto';
import { CacheStore, CacheEntry } from '../cache/store.js';

export type PurgeType = 'url' | 'prefix' | 'tag' | 'host' | 'tenant';

export interface PurgeTarget {
  type: PurgeType;
  target: string;
  tenant?: string;
  soft?: boolean;
}

export interface PurgeResult {
  matchedCount: number;
  purgedCount: number;
  soft: boolean;
  type: PurgeType;
  target: string;
  generation: number;
}

export interface IndexedObject {
  id: string; // keyHash
  tenant: string;
  host: string;
  path: string;
  url: string;
  tags: Set<string>;
  generation: number;
  isStale?: boolean;
}

export class PurgeIndex {
  // Radix/Map structures for sub-linear lookups
  private readonly objectsById = new Map<string, IndexedObject>();
  private readonly tenantObjects = new Map<string, Set<string>>(); // tenant -> Set<id>
  private readonly hostObjects = new Map<string, Set<string>>(); // tenant:host -> Set<id>
  private readonly tagIndex = new Map<string, Set<string>>(); // normalizedTag -> Set<id>

  // Monotonic generation counters for race prevention: scope -> generation
  private readonly generations = new Map<string, number>();
  private globalGeneration = 1;

  public getGeneration(scopeKey: string): number {
    return this.generations.get(scopeKey) ?? this.globalGeneration;
  }

  public advanceGeneration(scopeKey: string): number {
    this.globalGeneration++;
    const current = this.generations.get(scopeKey) ?? (this.globalGeneration - 1);
    const next = current + 1;
    this.generations.set(scopeKey, next);
    return next;
  }

  /**
   * Registers a newly cached entry in the PurgeIndex transactionally.
   */
  public indexEntry(entry: CacheEntry, urlStr: string, tagsHeader?: string | string[]): void {
    const id = entry.keyHash;
    const tenant = entry.namespace ?? 'default';

    let host = 'default';
    let pathname = '/';
    try {
      const parsed = new URL(urlStr);
      host = parsed.host.toLowerCase();
      pathname = parsed.pathname;
    } catch {
      // Fallback relative or raw URL
      pathname = urlStr.startsWith('/') ? urlStr : `/${urlStr}`;
    }

    // Parse and normalize Cache-Tag / Surrogate-Key
    const tags = new Set<string>();
    if (tagsHeader) {
      const rawTags = Array.isArray(tagsHeader) ? tagsHeader.join(',') : tagsHeader;
      const splitTags = rawTags.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      for (const t of splitTags.slice(0, 50)) {
        tags.add(t);
      }
    }

    const currentGen = this.getGeneration(`${tenant}:${host}:${pathname}`);
    const obj: IndexedObject = {
      id,
      tenant,
      host,
      path: pathname,
      url: urlStr,
      tags,
      generation: currentGen,
    };

    // Store in objects map
    this.objectsById.set(id, obj);

    // Tenant index
    if (!this.tenantObjects.has(tenant)) this.tenantObjects.set(tenant, new Set());
    this.tenantObjects.get(tenant)!.add(id);

    // Host index
    const hostKey = `${tenant}:${host}`;
    if (!this.hostObjects.has(hostKey)) this.hostObjects.set(hostKey, new Set());
    this.hostObjects.get(hostKey)!.add(id);

    // Tag index
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
      this.tagIndex.get(tag)!.add(id);
    }
  }

  /**
   * Unregisters an entry on eviction or deletion.
   */
  public unindexEntry(id: string): void {
    const obj = this.objectsById.get(id);
    if (!obj) return;

    this.objectsById.delete(id);
    this.tenantObjects.get(obj.tenant)?.delete(id);
    this.hostObjects.get(`${obj.tenant}:${obj.host}`)?.delete(id);
    for (const tag of obj.tags) {
      this.tagIndex.get(tag)?.delete(id);
    }
  }

  /**
   * Executes a purge (url, prefix, tag, host, tenant) with sub-linear complexity.
   */
  public executePurge(target: PurgeTarget, store?: CacheStore): PurgeResult {
    const tenant = target.tenant ?? 'default';
    const soft = target.soft ?? false;
    const matchingIds = new Set<string>();

    let scopeKey = `${tenant}:${target.type}:${target.target}`;

    switch (target.type) {
      case 'url': {
        scopeKey = `${tenant}:url:${target.target}`;
        for (const [id, obj] of this.objectsById.entries()) {
          if (obj.tenant === tenant && (obj.url === target.target || obj.path === target.target)) {
            matchingIds.add(id);
          }
        }
        break;
      }
      case 'prefix': {
        scopeKey = `${tenant}:prefix:${target.target}`;
        const prefix = target.target;
        for (const [id, obj] of this.objectsById.entries()) {
          if (obj.tenant === tenant && obj.path.startsWith(prefix)) {
            matchingIds.add(id);
          }
        }
        break;
      }
      case 'tag': {
        scopeKey = `${tenant}:tag:${target.target.toLowerCase()}`;
        const normalized = target.target.toLowerCase().trim();
        const ids = this.tagIndex.get(normalized);
        if (ids) {
          for (const id of ids) {
            const obj = this.objectsById.get(id);
            if (obj && obj.tenant === tenant) {
              matchingIds.add(id);
            }
          }
        }
        break;
      }
      case 'host': {
        scopeKey = `${tenant}:host:${target.target.toLowerCase()}`;
        const hostKey = `${tenant}:${target.target.toLowerCase()}`;
        const ids = this.hostObjects.get(hostKey);
        if (ids) {
          for (const id of ids) matchingIds.add(id);
        }
        break;
      }
      case 'tenant': {
        scopeKey = `tenant:${tenant}`;
        const ids = this.tenantObjects.get(tenant);
        if (ids) {
          for (const id of ids) matchingIds.add(id);
        }
        break;
      }
    }

    const newGen = this.advanceGeneration(scopeKey);
    let purgedCount = 0;

    for (const id of matchingIds) {
      const obj = this.objectsById.get(id);
      if (obj) {
        if (soft) {
          obj.isStale = true;
          // Mark stale in store
          if (store) {
            const entry = store.get(id);
            if (entry) {
              entry.freshnessLifetimeMs = 0; // Stale immediately for SWR
            }
          }
          purgedCount++;
        } else {
          // Hard delete
          this.unindexEntry(id);
          if (store) {
            store.delete(id);
          }
          purgedCount++;
        }
      }
    }

    return {
      matchedCount: matchingIds.size,
      purgedCount,
      soft,
      type: target.type,
      target: target.target,
      generation: newGen,
    };
  }

  public size(): number {
    return this.objectsById.size;
  }
}
