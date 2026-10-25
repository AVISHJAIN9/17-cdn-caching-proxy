import { describe, it, expect } from 'vitest';
import { LfuPolicy } from '../src/cache/eviction/lfu.js';
import { LruPolicy } from '../src/cache/eviction/lru.js';
import { EvictionPolicy } from '../src/cache/eviction/policy.js';

describe('Feature 33: LFU eviction policy', () => {
  it('conforms to the pluggable EvictionPolicy interface', () => {
    const lfu: EvictionPolicy = new LfuPolicy();
    expect(lfu.name).toBe('lfu');
    expect(typeof lfu.onInsert).toBe('function');
    expect(typeof lfu.onAccess).toBe('function');
    expect(typeof lfu.onRemove).toBe('function');
    expect(typeof lfu.pickVictim).toBe('function');
  });

  it('evicts the lowest-frequency entry first', () => {
    const lfu = new LfuPolicy();

    lfu.onInsert('k-high', { keyHash: 'k-high', lastAccessedAt: 1000 });
    lfu.onInsert('k-mid', { keyHash: 'k-mid', lastAccessedAt: 1000 });
    lfu.onInsert('k-low', { keyHash: 'k-low', lastAccessedAt: 1000 });

    // k-high gets 3 additional accesses (frequency = 4)
    lfu.onAccess('k-high', 1100);
    lfu.onAccess('k-high', 1200);
    lfu.onAccess('k-high', 1300);

    // k-mid gets 1 additional access (frequency = 2)
    lfu.onAccess('k-mid', 1150);

    // k-low gets 0 additional accesses (frequency = 1)

    // Lowest frequency is k-low
    expect(lfu.pickVictim()).toBe('k-low');
    lfu.onRemove('k-low');

    // Next lowest frequency is k-mid
    expect(lfu.pickVictim()).toBe('k-mid');
    lfu.onRemove('k-mid');

    // Highest frequency is k-high
    expect(lfu.pickVictim()).toBe('k-high');
    lfu.onRemove('k-high');

    expect(lfu.pickVictim()).toBeUndefined();
  });

  it('uses a deterministic, documented tie-break (oldest lastAccessedAt, then lexicographical)', () => {
    const lfu = new LfuPolicy();

    // Two entries with identical frequency = 1, but different lastAccessedAt
    lfu.onInsert('entry-older', { keyHash: 'entry-older', lastAccessedAt: 500 });
    lfu.onInsert('entry-newer', { keyHash: 'entry-newer', lastAccessedAt: 900 });

    // Older entry must be evicted first as documented tie-break
    expect(lfu.pickVictim()).toBe('entry-older');
    lfu.onRemove('entry-older');
    expect(lfu.pickVictim()).toBe('entry-newer');

    // Test secondary lexicographical tie-break when both frequency and lastAccessedAt match
    lfu.clear();
    lfu.onInsert('zebra', { keyHash: 'zebra', lastAccessedAt: 1000 });
    lfu.onInsert('alpha', { keyHash: 'alpha', lastAccessedAt: 1000 });

    expect(lfu.pickVictim()).toBe('alpha');
  });

  it('protects an old entry when it receives a burst of hits', () => {
    const lfu = new LfuPolicy();

    // Insert old entry at t=100
    lfu.onInsert('old-popular', { keyHash: 'old-popular', lastAccessedAt: 100 });

    // Give old-popular a burst of 5 hits
    for (let i = 0; i < 5; i++) {
      lfu.onAccess('old-popular', 150 + i * 10);
    } // frequency = 6

    // Later at t=1000, two new entries arrive with low activity
    lfu.onInsert('new-idle-1', { keyHash: 'new-idle-1', lastAccessedAt: 1000 }); // freq = 1
    lfu.onInsert('new-idle-2', { keyHash: 'new-idle-2', lastAccessedAt: 1010 }); // freq = 1

    // New entries are accessed once
    lfu.onAccess('new-idle-2', 1020); // freq = 2

    // Despite being older and not accessed recently, old-popular is protected by frequency!
    expect(lfu.pickVictim()).toBe('new-idle-1'); // freq 1
    lfu.onRemove('new-idle-1');

    expect(lfu.pickVictim()).toBe('new-idle-2'); // freq 2
    lfu.onRemove('new-idle-2');

    expect(lfu.pickVictim()).toBe('old-popular'); // freq 6
  });

  describe('Policy switching: LRU and LFU run through the same interface and test harness', () => {
    function testHarness(policy: EvictionPolicy) {
      expect(policy.size()).toBe(0);
      expect(policy.pickVictim()).toBeUndefined();

      policy.onInsert('item-1', { keyHash: 'item-1', lastAccessedAt: 100 });
      policy.onInsert('item-2', { keyHash: 'item-2', lastAccessedAt: 200 });
      expect(policy.size()).toBe(2);

      const victim = policy.pickVictim();
      expect(victim).toBeDefined();
      expect(['item-1', 'item-2']).toContain(victim);

      policy.onRemove(victim!);
      expect(policy.size()).toBe(1);

      policy.clear();
      expect(policy.size()).toBe(0);
      expect(policy.pickVictim()).toBeUndefined();
    }

    it('executes shared test harness on LRU policy', () => {
      testHarness(new LruPolicy());
    });

    it('executes shared test harness on LFU policy', () => {
      testHarness(new LfuPolicy());
    });
  });
});
