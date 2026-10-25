export interface EvictionCandidate {
  keyHash: string;
  size?: number;
  lastAccessedAt?: number;
  hitCount?: number;
}

/**
 * Common pluggable interface for cache eviction policies (e.g. LRU, LFU).
 */
export interface EvictionPolicy {
  readonly name: string;

  /**
   * Called when a key is newly stored or updated.
   */
  onInsert(keyHash: string, candidate?: EvictionCandidate): void;

  /**
   * Called when a key is accessed/hit.
   */
  onAccess(keyHash: string, accessedAt?: number): void;

  /**
   * Called when a key is removed or evicted.
   */
  onRemove(keyHash: string): void;

  /**
   * Returns the next candidate key to evict according to policy criteria,
   * optionally filtering candidates via isEligible.
   */
  pickVictim(isEligible?: (keyHash: string) => boolean): string | undefined;

  /**
   * Returns current count of tracked keys.
   */
  size(): number;

  /**
   * Clears all tracking state.
   */
  clear(): void;
}
