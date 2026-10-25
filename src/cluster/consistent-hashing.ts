/**
 * Consistent Hash Ring (Ketama-style) for Key -> Node ownership.
 * Feature 148: Deterministic consistent hashing with virtual nodes,
 * replica walk, atomic ring snapshot swapping, and versioning.
 */

export interface HashRingNode {
  id: string;
  weight: number;
}

interface RingPoint {
  hash: bigint;
  nodeId: string;
}

export interface ConsistentHashRingOptions {
  vnodes?: number; // Virtual nodes per weight unit (default: 160)
}

/**
 * 64-bit FNV-1a Hash implementation using native BigInt.
 * Guarantees bit-identical results across all platforms, Node versions, and OS architectures.
 */
export function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask64 = 0xffffffffffffffffn;

  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask64;
  }

  // Murmur3 64-bit avalanche mixer for uniform bit distribution across ring
  hash ^= hash >> 33n;
  hash = (hash * 0xff51afd7ed558ccdn) & mask64;
  hash ^= hash >> 33n;
  hash = (hash * 0xc4ceb9fe1a85ec53n) & mask64;
  hash ^= hash >> 33n;

  return hash;
}

export class ConsistentHashRing {
  private readonly vnodesPerWeight: number;
  private readonly nodes: Map<string, HashRingNode> = new Map();

  // Immutable active snapshot for lock-free reads
  private ringPoints: RingPoint[] = [];
  private ringHashes: bigint[] = [];
  private ringVersion: number = 0;

  constructor(options: ConsistentHashRingOptions = {}) {
    this.vnodesPerWeight = options.vnodes ?? 160;
  }

  public get version(): number {
    return this.ringVersion;
  }

  public getNodeCount(): number {
    return this.nodes.size;
  }

  public getVirtualNodeCount(): number {
    return this.ringPoints.length;
  }

  public getNodes(): HashRingNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  public hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /**
   * Adds or updates a physical node with the given weight.
   */
  public addNode(nodeId: string, weight: number = 1): void {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('Node ID must be a non-empty string');
    }
    if (weight <= 0 || !Number.isFinite(weight)) {
      throw new Error(`Weight must be a positive finite number, got ${weight}`);
    }

    this.nodes.set(nodeId, { id: nodeId, weight });
    this.rebuildRing();
  }

  /**
   * Removes a physical node from the ring.
   */
  public removeNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) {
      return false;
    }
    this.nodes.delete(nodeId);
    this.rebuildRing();
    return true;
  }

  /**
   * Updates node weight.
   */
  public setWeight(nodeId: string, weight: number): void {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} does not exist in hash ring`);
    }
    this.addNode(nodeId, weight);
  }

  /**
   * Maps a key to the primary owning physical node.
   * Lock-free O(log V) binary search on immutable snapshot.
   */
  public getNode(key: string): string | undefined {
    if (this.ringPoints.length === 0) {
      return undefined;
    }

    const keyHash = fnv1a64(key);
    const index = this.findClosestIndex(keyHash);
    return this.ringPoints[index].nodeId;
  }

  /**
   * Returns n DISTINCT physical nodes walking clockwise starting at the key's position.
   */
  public getReplicaNodes(key: string, count: number): string[] {
    if (this.ringPoints.length === 0 || count <= 0) {
      return [];
    }

    const availableNodes = this.nodes.size;
    const targetCount = Math.min(count, availableNodes);
    const result: string[] = [];
    const seen = new Set<string>();

    const keyHash = fnv1a64(key);
    let index = this.findClosestIndex(keyHash);
    const totalPoints = this.ringPoints.length;

    for (let i = 0; i < totalPoints && result.length < targetCount; i++) {
      const candidate = this.ringPoints[index].nodeId;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        result.push(candidate);
      }
      index = (index + 1) % totalPoints;
    }

    return result;
  }

  /**
   * Binary search to find the smallest point hash >= keyHash (wrapping to index 0).
   */
  private findClosestIndex(targetHash: bigint): number {
    const hashes = this.ringHashes;
    let low = 0;
    let high = hashes.length - 1;

    if (targetHash > hashes[high] || targetHash <= hashes[0]) {
      return 0;
    }

    let result = 0;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (hashes[mid] >= targetHash) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  /**
   * Atomically compiles and swaps a new immutable ring point array.
   */
  private rebuildRing(): void {
    const newPoints: RingPoint[] = [];

    for (const node of this.nodes.values()) {
      const vnodeCount = Math.round(this.vnodesPerWeight * node.weight);
      for (let i = 0; i < vnodeCount; i++) {
        const vnodeKey = `${node.id}#${i}`;
        const hash = fnv1a64(vnodeKey);
        newPoints.push({ hash, nodeId: node.id });
      }
    }

    // Sort ascending by 64-bit hash
    newPoints.sort((a, b) => {
      if (a.hash < b.hash) return -1;
      if (a.hash > b.hash) return 1;
      return a.nodeId.localeCompare(b.nodeId);
    });

    // Atomic snapshot swap
    this.ringPoints = newPoints;
    this.ringHashes = newPoints.map((p) => p.hash);
    this.ringVersion++;
  }
}
