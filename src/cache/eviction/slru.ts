import { EvictionPolicy, EvictionCandidate } from './policy.js';

export interface SlruOptions {
  /**
   * Proportion of total capacity allocated to the protected segment.
   * Default: 0.8 (80% protected, 20% probation).
   */
  protectedRatio?: number;
  /**
   * Maximum entries ceiling used to partition segment capacities.
   * Default: 10000.
   */
  maxEntries?: number;
}

/**
 * Segmented LRU (SLRU) eviction policy.
 * Partitions entries into two segments:
 * 1. Probation: holds newly inserted entries (one-hit candidates).
 * 2. Protected: holds entries that have been accessed two or more times.
 *
 * Scan Resistance: A burst of sequential one-hit requests flushes only through
 * the probation segment and cannot displace frequently accessed entries in protected.
 */
export class SlruPolicy implements EvictionPolicy {
  public readonly name = 'slru';
  public readonly protectedRatio: number;
  public readonly maxEntries: number;

  private readonly probation: Map<string, number> = new Map();
  private readonly protected: Map<string, number> = new Map();

  constructor(options: SlruOptions = {}) {
    const ratio = options.protectedRatio ?? 0.8;
    this.protectedRatio = Math.max(0.01, Math.min(0.99, ratio));
    this.maxEntries = options.maxEntries ?? 10000;
  }

  get protectedCapacity(): number {
    return Math.max(1, Math.round(this.maxEntries * this.protectedRatio));
  }

  get probationCapacity(): number {
    return Math.max(1, this.maxEntries - this.protectedCapacity);
  }

  onInsert(keyHash: string, candidate?: EvictionCandidate): void {
    const timestamp = candidate?.lastAccessedAt ?? Date.now();

    if (this.protected.has(keyHash)) {
      // Re-position at the most-recently-used tail of protected
      this.protected.delete(keyHash);
      this.protected.set(keyHash, timestamp);
      return;
    }

    if (this.probation.has(keyHash)) {
      // Re-position at the MRU tail of probation
      this.probation.delete(keyHash);
      this.probation.set(keyHash, timestamp);
      return;
    }

    // New entry starts in the probationary segment
    this.probation.set(keyHash, timestamp);
  }

  onAccess(keyHash: string, accessedAt?: number): void {
    const timestamp = accessedAt ?? Date.now();

    if (this.probation.has(keyHash)) {
      // Promotion from probation to protected segment on hit
      this.probation.delete(keyHash);
      this.protected.set(keyHash, timestamp);

      // Enforce protected segment capacity limit: demote LRU of protected back to probation
      if (this.protected.size > this.protectedCapacity) {
        const oldestProtectedKey = this.protected.keys().next().value;
        if (oldestProtectedKey) {
          const oldTime = this.protected.get(oldestProtectedKey)!;
          this.protected.delete(oldestProtectedKey);
          // Place at the MRU head of probation
          this.probation.delete(oldestProtectedKey);
          this.probation.set(oldestProtectedKey, oldTime);
        }
      }
      return;
    }

    if (this.protected.has(keyHash)) {
      // Re-order within protected segment
      this.protected.delete(keyHash);
      this.protected.set(keyHash, timestamp);
      return;
    }

    // Not previously tracked: start in probation
    this.probation.set(keyHash, timestamp);
  }

  onRemove(keyHash: string): void {
    this.probation.delete(keyHash);
    this.protected.delete(keyHash);
  }

  pickVictim(isEligible?: (keyHash: string) => boolean): string | undefined {
    // 1. Evict from probation segment first (oldest unaccessed entries)
    for (const key of this.probation.keys()) {
      if (!isEligible || isEligible(key)) {
        return key;
      }
    }

    // 2. If probation is empty or all entries protected, evict from protected segment
    for (const key of this.protected.keys()) {
      if (!isEligible || isEligible(key)) {
        return key;
      }
    }

    return undefined;
  }

  isInProbation(keyHash: string): boolean {
    return this.probation.has(keyHash);
  }

  isInProtected(keyHash: string): boolean {
    return this.protected.has(keyHash);
  }

  size(): number {
    return this.probation.size + this.protected.size;
  }

  clear(): void {
    this.probation.clear();
    this.protected.clear();
  }
}
