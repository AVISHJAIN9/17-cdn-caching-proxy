import { EvictionPolicy, EvictionCandidate } from './policy.js';

interface LfuEntry {
  keyHash: string;
  frequency: number;
  lastAccessedAt: number;
}

/**
 * Least Frequently Used (LFU) eviction policy.
 * Evicts the entry with the lowest access frequency first.
 *
 * Deterministic Tie-Break:
 * 1. Oldest `lastAccessedAt` timestamp (LRU among equal frequency items).
 * 2. Lexicographical comparison of `keyHash` if timestamps are identical.
 */
export class LfuPolicy implements EvictionPolicy {
  public readonly name = 'lfu';
  private readonly entries: Map<string, LfuEntry> = new Map();

  onInsert(keyHash: string, candidate?: EvictionCandidate): void {
    const existing = this.entries.get(keyHash);
    const initialFreq = candidate?.hitCount !== undefined
      ? candidate.hitCount + 1
      : (existing ? existing.frequency + 1 : 1);
    const accessedAt = candidate?.lastAccessedAt ?? Date.now();

    this.entries.set(keyHash, {
      keyHash,
      frequency: initialFreq,
      lastAccessedAt: accessedAt,
    });
  }

  onAccess(keyHash: string, accessedAt?: number): void {
    const entry = this.entries.get(keyHash);
    if (!entry) return;
    entry.frequency++;
    entry.lastAccessedAt = accessedAt ?? Date.now();
  }

  onRemove(keyHash: string): void {
    this.entries.delete(keyHash);
  }

  pickVictim(isEligible?: (keyHash: string) => boolean): string | undefined {
    if (this.entries.size === 0) return undefined;

    let minEntry: LfuEntry | undefined;

    for (const entry of this.entries.values()) {
      if (isEligible && !isEligible(entry.keyHash)) {
        continue;
      }

      if (!minEntry) {
        minEntry = entry;
        continue;
      }

      if (entry.frequency < minEntry.frequency) {
        minEntry = entry;
      } else if (entry.frequency === minEntry.frequency) {
        // Documented tie-break 1: older lastAccessedAt wins (evicted first)
        if (entry.lastAccessedAt < minEntry.lastAccessedAt) {
          minEntry = entry;
        } else if (entry.lastAccessedAt === minEntry.lastAccessedAt) {
          // Documented tie-break 2: lexicographical order of keyHash
          if (entry.keyHash < minEntry.keyHash) {
            minEntry = entry;
          }
        }
      }
    }

    return minEntry?.keyHash;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
