import { describe, it, expect } from 'vitest';
import { LruPolicy } from '../src/cache/eviction/lru.js';
import { EvictionPolicy } from '../src/cache/eviction/policy.js';

describe('Feature 32: LRU eviction policy', () => {
  it('conforms to the pluggable EvictionPolicy interface', () => {
    const policy: EvictionPolicy = new LruPolicy();
    expect(policy.name).toBe('lru');
    expect(typeof policy.onInsert).toBe('function');
    expect(typeof policy.onAccess).toBe('function');
    expect(typeof policy.onRemove).toBe('function');
    expect(typeof policy.pickVictim).toBe('function');
  });

  it('eviction order follows access order exactly; oldest goes first', () => {
    const lru = new LruPolicy();

    lru.onInsert('k1');
    lru.onInsert('k2');
    lru.onInsert('k3');

    // Initially k1 is the oldest
    expect(lru.pickVictim()).toBe('k1');
  });

  it('a hit moves the entry to most-recent, protecting it from being the next victim', () => {
    const lru = new LruPolicy();

    lru.onInsert('A');
    lru.onInsert('B');
    lru.onInsert('C');

    // Access A -> now access order is B, C, A
    lru.onAccess('A');
    expect(lru.pickVictim()).toBe('B');

    // Access B -> now access order is C, A, B
    lru.onAccess('B');
    expect(lru.pickVictim()).toBe('C');

    // Remove C -> now access order is A, B
    lru.onRemove('C');
    expect(lru.pickVictim()).toBe('A');

    // Remove A -> only B remains
    lru.onRemove('A');
    expect(lru.pickVictim()).toBe('B');

    // Remove B -> empty
    lru.onRemove('B');
    expect(lru.pickVictim()).toBeUndefined();
  });

  it('handles re-insert of existing key by promoting to most recent', () => {
    const lru = new LruPolicy();
    lru.onInsert('key1');
    lru.onInsert('key2');

    expect(lru.pickVictim()).toBe('key1');

    // Re-insert key1 (e.g. cache replacement)
    lru.onInsert('key1');
    expect(lru.pickVictim()).toBe('key2');
  });

  it('preserves exact strict access order across a sequence of mixed inserts and hits', () => {
    const lru = new LruPolicy();
    const items = ['x1', 'x2', 'x3', 'x4', 'x5'];
    for (const item of items) {
      lru.onInsert(item);
    }

    // Access sequence: x2, then x1, then x4
    lru.onAccess('x2');
    lru.onAccess('x1');
    lru.onAccess('x4');

    // Remaining order from least to most recent should be:
    // x3 (untouched), x5 (untouched), x2, x1, x4
    const evictedOrder: string[] = [];
    while (lru.size() > 0) {
      const victim = lru.pickVictim()!;
      evictedOrder.push(victim);
      lru.onRemove(victim);
    }

    expect(evictedOrder).toEqual(['x3', 'x5', 'x2', 'x1', 'x4']);
  });
});
