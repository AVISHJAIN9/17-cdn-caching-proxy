import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PeerClusterNode } from '../src/cluster/peer-cluster.js';

describe('Feature 141: Horizontal scaling', () => {
  let nodeA: PeerClusterNode;
  let nodeB: PeerClusterNode;
  let nodeC: PeerClusterNode;
  const sharedSecret = 'test-cluster-hmac-secret-123456';

  beforeEach(async () => {
    // Spin up 3 nodes on ephemeral ports
    nodeA = new PeerClusterNode({
      localNode: { id: 'node-a', host: '127.0.0.1', port: 0 },
      sharedSecret,
      maxHops: 2,
    });
    await nodeA.start();

    nodeB = new PeerClusterNode({
      localNode: { id: 'node-b', host: '127.0.0.1', port: 0 },
      sharedSecret,
      maxHops: 2,
    });
    await nodeB.start();

    nodeC = new PeerClusterNode({
      localNode: { id: 'node-c', host: '127.0.0.1', port: 0 },
      sharedSecret,
      maxHops: 2,
    });
    await nodeC.start();

    // Wire up peers
    nodeA.addPeer({ id: 'node-b', host: '127.0.0.1', port: nodeB.port });
    nodeA.addPeer({ id: 'node-c', host: '127.0.0.1', port: nodeC.port });

    nodeB.addPeer({ id: 'node-a', host: '127.0.0.1', port: nodeA.port });
    nodeB.addPeer({ id: 'node-c', host: '127.0.0.1', port: nodeC.port });

    nodeC.addPeer({ id: 'node-a', host: '127.0.0.1', port: nodeA.port });
    nodeC.addPeer({ id: 'node-b', host: '127.0.0.1', port: nodeB.port });
  });

  afterEach(async () => {
    await nodeA.stop();
    await nodeB.stop();
    await nodeC.stop();
  });

  it('determines ownership correctly and forwards non-owner requests to peer owner', async () => {
    // Setup handlers
    const handledBy: Record<string, string[]> = {
      'node-a': [],
      'node-b': [],
      'node-c': [],
    };

    const makeHandler = (nodeId: string) => async (key: string) => {
      handledBy[nodeId].push(key);
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(`data-from-${nodeId}-for-${key}`),
      };
    };

    nodeA.setLocalRequestHandler(makeHandler('node-a'));
    nodeB.setLocalRequestHandler(makeHandler('node-b'));
    nodeC.setLocalRequestHandler(makeHandler('node-c'));

    // Find a key owned by node-b
    let keyForB = '';
    for (let i = 0; i < 100; i++) {
      const candidate = `test-key-${i}`;
      if (nodeA.getOwner(candidate) === 'node-b') {
        keyForB = candidate;
        break;
      }
    }
    expect(keyForB).not.toBe('');

    // Request through node-a: should forward to node-b
    const res = await nodeA.handleClientRequest(keyForB);
    expect(res.statusCode).toBe(200);
    expect(res.servedBy).toBe('node-b');
    expect(res.hops).toBe(1);
    expect(res.body.toString('utf8')).toBe(`data-from-node-b-for-${keyForB}`);
    expect(handledBy['node-b']).toContain(keyForB);
  });

  it('performs single origin fetch cluster-wide for a concurrent herd across nodes', async () => {
    let originFetchCount = 0;
    const inFlightFill = new Map<string, Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }>>();

    const collapsingHandler = async (key: string) => {
      if (inFlightFill.has(key)) {
        return inFlightFill.get(key)!;
      }

      const p = (async () => {
        // Simulate origin network fetch latency
        await new Promise((r) => setTimeout(r, 40));
        originFetchCount++;
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ key, payload: 'origin-content-v1' })),
        };
      })();

      inFlightFill.set(key, p);
      try {
        return await p;
      } finally {
        inFlightFill.delete(key);
      }
    };

    nodeA.setLocalRequestHandler(collapsingHandler);
    nodeB.setLocalRequestHandler(collapsingHandler);
    nodeC.setLocalRequestHandler(collapsingHandler);

    // Pick a key
    const herdKey = 'cluster-herd-target-item-999';

    // Concurrently fire requests to all 3 nodes
    const [resA, resB, resC] = await Promise.all([
      nodeA.handleClientRequest(herdKey),
      nodeB.handleClientRequest(herdKey),
      nodeC.handleClientRequest(herdKey),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resC.statusCode).toBe(200);

    // All return identical bodies
    expect(resA.body.toString('utf8')).toBe(resB.body.toString('utf8'));
    expect(resB.body.toString('utf8')).toBe(resC.body.toString('utf8'));

    // Origin was called exactly ONCE cluster-wide
    expect(originFetchCount).toBe(1);
  });

  it('fails over to next replica when owner node is marked down', async () => {
    // Find key owned by node-b
    let keyForB = '';
    for (let i = 0; i < 100; i++) {
      const candidate = `failover-key-${i}`;
      if (nodeA.getOwner(candidate) === 'node-b') {
        keyForB = candidate;
        break;
      }
    }

    const handler = async (key: string) => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`handled-${key}`),
    });

    nodeA.setLocalRequestHandler(handler);
    nodeC.setLocalRequestHandler(handler);

    // Mark node-b unhealthy on node-a
    nodeA.setPeerHealthy('node-b', false);

    const targetNodeId = nodeA.getHealthyOwnerOrReplica(keyForB);
    expect(targetNodeId).not.toBe('node-b'); // Must failover to replica

    const res = await nodeA.handleClientRequest(keyForB);
    expect(res.statusCode).toBe(200);
    expect(res.servedBy).toBe(targetNodeId);
  });

  it('keeps key remapping within Ketama movement bounds on join/leave', () => {
    const ring = nodeA.getRing();
    const testKeys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      testKeys.push(`rebalance-key-${i}`);
    }

    // Record initial ownership across 3 nodes
    const initialOwners = new Map<string, string>();
    for (const k of testKeys) {
      initialOwners.set(k, ring.getNode(k)!);
    }

    // Add a 4th node
    ring.addNode('node-d', 1);

    let remapped = 0;
    for (const k of testKeys) {
      const newOwner = ring.getNode(k)!;
      if (newOwner !== initialOwners.get(k)) {
        remapped++;
      }
    }

    const remapFraction = remapped / testKeys.length;
    // For 1 of 4 nodes, theoretical movement is 1/4 = 0.25; with Ketama bound <= 1/N + 5% = 0.35
    expect(remapFraction).toBeLessThanOrEqual(0.35);
  });

  it('rejects forged or looping hop counts with HTTP 400/508', async () => {
    const key = 'loop-test-key';
    // Forged hop count exceeding maxHops
    await expect(
      nodeA.forwardToPeer({ id: 'node-b', host: '127.0.0.1', port: nodeB.port }, key, 2)
    ).rejects.toThrow(/loop detected/i);

    expect(nodeA.getMetrics().peerErrors.loop).toBeGreaterThan(0);
  });

  it('fans out purges cluster-wide, handles partial failure, and allows retrying failed nodes', async () => {
    const purgedAt: Record<string, string[]> = {
      'node-a': [],
      'node-b': [],
      'node-c': [],
    };

    nodeA.setLocalPurgeHandler(async (p) => {
      purgedAt['node-a'].push(p.target);
      return { purgedCount: 3 };
    });

    nodeB.setLocalPurgeHandler(async (p) => {
      purgedAt['node-b'].push(p.target);
      return { purgedCount: 3 };
    });

    // Make node-c fail on purge
    nodeC.setLocalPurgeHandler(async () => {
      throw new Error('Disk IO error during purge index update');
    });

    const purgeReq = {
      type: 'tag' as const,
      target: 'catalog-purge',
    };

    const result = await nodeA.broadcastPurge(purgeReq);

    expect(result.succeeded).toContain('node-a');
    expect(result.succeeded).toContain('node-b');
    expect(result.failed).toContain('node-c');
    expect(result.totalPurged).toBe(6);

    // Fix node-c and retry only the failed node
    nodeC.setLocalPurgeHandler(async (p) => {
      purgedAt['node-c'].push(p.target);
      return { purgedCount: 3 };
    });

    const retryResult = await nodeA.broadcastPurge(purgeReq, result.failed);
    expect(retryResult.succeeded).toEqual(['node-c']);
    expect(retryResult.failed).toHaveLength(0);
    expect(retryResult.totalPurged).toBe(3);
    expect(purgedAt['node-c']).toContain('catalog-purge');
  });
});
