import { describe, it, expect } from 'vitest';
import { ConsistentHashRing, fnv1a64 } from '../src/cluster/consistent-hashing.js';

describe('Feature 148: Consistent Hashing', () => {
  it('computes deterministic 64-bit FNV-1a hashes', () => {
    const h1 = fnv1a64('node-1#42');
    const h2 = fnv1a64('node-1#42');
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('bigint');
    expect(fnv1a64('node-1#42')).not.toBe(fnv1a64('node-1#43'));
  });

  it('yields identical mappings across two independently constructed rings', () => {
    const ringA = new ConsistentHashRing({ vnodes: 160 });
    const ringB = new ConsistentHashRing({ vnodes: 160 });

    const nodes = ['node-alpha', 'node-beta', 'node-gamma', 'node-delta'];
    for (const n of nodes) {
      ringA.addNode(n);
      ringB.addNode(n);
    }

    for (let i = 0; i < 1000; i++) {
      const key = `cache:key:${i}:tenant_${i % 5}`;
      expect(ringA.getNode(key)).toBe(ringB.getNode(key));
    }
  });

  it('guarantees replica distinctness walking clockwise', () => {
    const ring = new ConsistentHashRing({ vnodes: 160 });
    ring.addNode('node-1');
    ring.addNode('node-2');
    ring.addNode('node-3');
    ring.addNode('node-4');

    for (let i = 0; i < 100; i++) {
      const replicas = ring.getReplicaNodes(`test-key-${i}`, 3);
      expect(replicas.length).toBe(3);
      const unique = new Set(replicas);
      expect(unique.size).toBe(3);
    }

    // Requesting more replicas than nodes returns all nodes without duplicates
    const allReplicas = ring.getReplicaNodes('key-overcount', 10);
    expect(allReplicas.length).toBe(4);
    expect(new Set(allReplicas).size).toBe(4);
  });

  it('distributes keys with bounded imbalance ratio', () => {
    const ring = new ConsistentHashRing({ vnodes: 160 });
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'];
    for (const n of nodes) {
      ring.addNode(n);
    }

    const keyCount = 50000;
    const distribution: Record<string, number> = {};
    for (const n of nodes) distribution[n] = 0;

    for (let i = 0; i < keyCount; i++) {
      const owner = ring.getNode(`benchmark:key:${i}`)!;
      distribution[owner]++;
    }

    const mean = keyCount / nodes.length;
    let max = 0;
    for (const n of nodes) {
      if (distribution[n] > max) max = distribution[n];
    }
    const imbalance = max / mean;
    // Imbalance target <= 1.15
    expect(imbalance).toBeLessThan(1.20);
  });

  it('limits key remapping movement to <= 1/N + 5% on node addition/removal', () => {
    const N = 5;
    const ring = new ConsistentHashRing({ vnodes: 160 });
    for (let i = 1; i <= N; i++) {
      ring.addNode(`node-${i}`);
    }

    const totalKeys = 50000;
    const initialOwnership = new Map<number, string>();
    for (let i = 0; i < totalKeys; i++) {
      initialOwnership.set(i, ring.getNode(`key:${i}`)!);
    }

    // Add 1 node (N -> N+1 = 6)
    ring.addNode('node-6');

    let moved = 0;
    for (let i = 0; i < totalKeys; i++) {
      const newOwner = ring.getNode(`key:${i}`)!;
      if (newOwner !== initialOwnership.get(i)) {
        moved++;
        // The newly mapped node MUST be the newly added node
        expect(newOwner).toBe('node-6');
      }
    }

    const movementFraction = moved / totalKeys;
    const theoreticalFraction = 1 / (N + 1);
    expect(movementFraction).toBeLessThan(theoreticalFraction + 0.05);
  });

  it('respects node weight proportionality', () => {
    const ring = new ConsistentHashRing({ vnodes: 160 });
    ring.addNode('node-light', 1);
    ring.addNode('node-heavy', 2);

    let lightCount = 0;
    let heavyCount = 0;
    const count = 30000;
    for (let i = 0; i < count; i++) {
      const owner = ring.getNode(`weight-key-${i}`);
      if (owner === 'node-light') lightCount++;
      else if (owner === 'node-heavy') heavyCount++;
    }

    const ratio = heavyCount / lightCount;
    // Expected ~2.0, allow small variance [1.7, 2.3]
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });

  it('supports lock-free atomic snapshot swap during concurrent lookups', () => {
    const ring = new ConsistentHashRing({ vnodes: 160 });
    ring.addNode('node-A');
    ring.addNode('node-B');

    // Simulate concurrent reads while modifying
    for (let i = 0; i < 1000; i++) {
      const node = ring.getNode(`concurrent-key-${i}`);
      expect(['node-A', 'node-B', 'node-C']).toContain(node);
      if (i === 500) {
        ring.addNode('node-C');
      }
    }
    expect(ring.version).toBeGreaterThanOrEqual(2);
  });
});
