import { EvictionPolicy, EvictionCandidate } from './policy.js';

/**
 * Least Recently Used (LRU) eviction policy.
 * Maintains strict access ordering where the oldest unaccessed entry is evicted first.
 * Built on a JavaScript Map where iteration order reflects insertion/access order.
 */
export class LruPolicy implements EvictionPolicy {
  public readonly name = 'lru';
  private readonly accessOrder: Map<string, number> = new Map();

  onInsert(keyHash: string, candidate?: EvictionCandidate): void {
    const timestamp = candidate?.lastAccessedAt ?? Date.now();
    // Delete and re-insert to position at the most-recently-used tail
    this.accessOrder.delete(keyHash);
    this.accessOrder.set(keyHash, timestamp);
  }

  onAccess(keyHash: string, accessedAt?: number): void {
    if (!this.accessOrder.has(keyHash)) return;
    const timestamp = accessedAt ?? Date.now();
    // Promote keyHash to the end of insertion order
    this.accessOrder.delete(keyHash);
    this.accessOrder.set(keyHash, timestamp);
  }

  onRemove(keyHash: string): void {
    this.accessOrder.delete(keyHash);
  }

  pickVictim(isEligible?: (keyHash: string) => boolean): string | undefined {
    for (const key of this.accessOrder.keys()) {
      if (!isEligible || isEligible(key)) {
        return key;
      }
    }
    return undefined;
  }

  size(): number {
    return this.accessOrder.size;
  }

  clear(): void {
    this.accessOrder.clear();
  }
}
