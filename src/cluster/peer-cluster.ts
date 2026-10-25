/**
 * Peer Cluster & Horizontal Scaling
 * Feature 141: Multi-node cluster with Ketama consistent hashing, peer ownership routing,
 * loop protection, replica failover, cluster purge fan-out, and rebalance.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { ConsistentHashRing, HashRingNode } from './consistent-hashing.js';

export interface PeerNodeConfig {
  id: string;
  host: string;
  port: number;
  weight?: number;
}

export interface PeerClusterConfig {
  localNode: PeerNodeConfig;
  peers?: PeerNodeConfig[];
  sharedSecret: string;
  maxHops?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  missedBeatsThreshold?: number;
  hotKeyLocalReplica?: boolean;
}

export interface NodeHealthState {
  healthy: boolean;
  consecutiveFailures: number;
  lastSeen: number;
}

export interface ClusterPurgeRequest {
  type: 'url' | 'prefix' | 'tag' | 'host' | 'tenant';
  target: string;
  tenant?: string;
  soft?: boolean;
}

export interface ClusterPurgeResponse {
  nodeId: string;
  status: 'ok' | 'error';
  purgedCount: number;
  error?: string;
}

export interface ClusterPurgeResult {
  succeeded: string[];
  failed: string[];
  totalPurged: number;
  nodeResults: Map<string, ClusterPurgeResponse>;
}

export interface ClusterMetrics {
  peerRequests: {
    forwarded: number;
    received: number;
    served: number;
  };
  peerErrors: {
    timeout: number;
    auth: number;
    loop: number;
    network: number;
  };
  ringVersion: number;
  activeNodes: number;
}

export type LocalRequestHandler = (
  key: string,
  reqHeaders?: Record<string, string | string[] | undefined>
) => Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

export type LocalPurgeHandler = (
  purge: ClusterPurgeRequest
) => Promise<{ purgedCount: number }>;

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export class PeerClusterNode {
  public readonly id: string;
  public readonly host: string;
  public readonly port: number;
  private readonly sharedSecret: string;
  private readonly maxHops: number;
  private readonly ring: ConsistentHashRing;
  private readonly nodeHealth: Map<string, NodeHealthState> = new Map();
  private readonly peers: Map<string, PeerNodeConfig> = new Map();

  private server?: http.Server;
  private heartbeatTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  private localRequestHandler?: LocalRequestHandler;
  private localPurgeHandler?: LocalPurgeHandler;

  private metrics: ClusterMetrics = {
    peerRequests: { forwarded: 0, received: 0, served: 0 },
    peerErrors: { timeout: 0, auth: 0, loop: 0, network: 0 },
    ringVersion: 0,
    activeNodes: 1,
  };

  constructor(private readonly config: PeerClusterConfig) {
    this.id = config.localNode.id;
    this.host = config.localNode.host;
    this.port = config.localNode.port;
    this.sharedSecret = config.sharedSecret;
    this.maxHops = config.maxHops ?? 2;

    this.ring = new ConsistentHashRing({ vnodes: 160 });
    this.ring.addNode(this.id, config.localNode.weight ?? 1);
    this.nodeHealth.set(this.id, { healthy: true, consecutiveFailures: 0, lastSeen: Date.now() });

    if (config.peers) {
      for (const peer of config.peers) {
        this.addPeer(peer);
      }
    }
  }

  public setLocalRequestHandler(handler: LocalRequestHandler): void {
    this.localRequestHandler = handler;
  }

  public setLocalPurgeHandler(handler: LocalPurgeHandler): void {
    this.localPurgeHandler = handler;
  }

  public getRing(): ConsistentHashRing {
    return this.ring;
  }

  public getMetrics(): ClusterMetrics {
    return {
      peerRequests: { ...this.metrics.peerRequests },
      peerErrors: { ...this.metrics.peerErrors },
      ringVersion: this.ring.version,
      activeNodes: Array.from(this.nodeHealth.values()).filter((h) => h.healthy).length,
    };
  }

  public addPeer(peer: PeerNodeConfig): void {
    this.peers.set(peer.id, { ...peer });
    this.ring.addNode(peer.id, peer.weight ?? 1);
    this.nodeHealth.set(peer.id, {
      healthy: true,
      consecutiveFailures: 0,
      lastSeen: Date.now(),
    });
    this.metrics.ringVersion = this.ring.version;
  }

  public removePeer(peerId: string): boolean {
    this.peers.delete(peerId);
    this.nodeHealth.delete(peerId);
    const removed = this.ring.removeNode(peerId);
    this.metrics.ringVersion = this.ring.version;
    return removed;
  }

  public setPeerHealthy(peerId: string, healthy: boolean): void {
    const state = this.nodeHealth.get(peerId);
    if (state) {
      state.healthy = healthy;
      if (!healthy) {
        state.consecutiveFailures = Math.max(state.consecutiveFailures, 3);
      } else {
        state.consecutiveFailures = 0;
        state.lastSeen = Date.now();
      }
    }
  }

  public isNodeHealthy(nodeId: string): boolean {
    if (nodeId === this.id) return true;
    const state = this.nodeHealth.get(nodeId);
    return state ? state.healthy : false;
  }

  public getOwner(key: string): string | undefined {
    return this.ring.getNode(key);
  }

  public getHealthyOwnerOrReplica(key: string): string {
    const owner = this.ring.getNode(key);
    if (owner && this.isNodeHealthy(owner)) {
      return owner;
    }

    // Failover: walk clockwise replicas for first healthy node
    const replicas = this.ring.getReplicaNodes(key, this.ring.getNodeCount());
    for (const replica of replicas) {
      if (this.isNodeHealthy(replica)) {
        return replica;
      }
    }

    // Default to owner if all fail
    return owner ?? this.id;
  }

  /**
   * Starts HTTP listener for inter-node peer traffic.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.server = http.createServer((req, res) => {
      this.handleIncomingPeerRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          (this as any).port = addr.port;
        }
        resolve();
      });
      this.server!.once('error', reject);
    });

    this.isRunning = true;
  }

  /**
   * Stops HTTP listener and cleans up timers.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }
  }

  /**
   * Primary entry point for routing a client request.
   * If local node is the owner, handles locally.
   * Otherwise forwards to the owner node with loop protection and failover.
   */
  public async handleClientRequest(
    key: string,
    reqHeaders: Record<string, string | string[] | undefined> = {}
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
    servedBy: string;
    hops: number;
  }> {
    const targetNodeId = this.getHealthyOwnerOrReplica(key);

    if (targetNodeId === this.id) {
      this.metrics.peerRequests.served++;
      if (!this.localRequestHandler) {
        throw new Error(`No localRequestHandler registered on node ${this.id}`);
      }
      const resp = await this.localRequestHandler(key, reqHeaders);
      return {
        ...resp,
        servedBy: this.id,
        hops: 0,
      };
    }

    // Forward to peer owner
    const peer = this.peers.get(targetNodeId);
    if (!peer) {
      throw new Error(`Target node ${targetNodeId} not found in peer directory`);
    }

    return this.forwardToPeer(peer, key, 0, reqHeaders);
  }

  /**
   * Forwards request to a remote peer node.
   */
  public async forwardToPeer(
    peer: PeerNodeConfig,
    key: string,
    currentHops: number,
    reqHeaders: Record<string, string | string[] | undefined> = {}
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
    servedBy: string;
    hops: number;
  }> {
    if (currentHops >= this.maxHops) {
      this.metrics.peerErrors.loop++;
      const err = new Error(`Max cluster hops (${this.maxHops}) exceeded - loop detected`);
      (err as any).statusCode = 508;
      throw err;
    }

    this.metrics.peerRequests.forwarded++;

    return new Promise((resolve, reject) => {
      const url = `http://${peer.host}:${peer.port}/cluster/peer-fill?key=${encodeURIComponent(key)}`;
      const headers: Record<string, string> = {
        'x-cdn-cluster-auth': this.sharedSecret,
        'x-cdn-hop-count': String(currentHops + 1),
        'via': `1.1 ${this.id}`,
      };

      const req = http.get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') {
              resHeaders[k] = v;
            } else if (Array.isArray(v)) {
              resHeaders[k] = v.join(', ');
            }
          }

          if (res.statusCode && res.statusCode >= 500) {
            this.recordNodeFailure(peer.id);
          } else {
            this.recordNodeSuccess(peer.id);
          }

          resolve({
            statusCode: res.statusCode ?? 200,
            headers: resHeaders,
            body,
            servedBy: peer.id,
            hops: currentHops + 1,
          });
        });
      });

      req.on('error', (err) => {
        this.metrics.peerErrors.network++;
        this.recordNodeFailure(peer.id);
        reject(err);
      });

      req.setTimeout(3000, () => {
        this.metrics.peerErrors.timeout++;
        req.destroy(new Error('Peer request timed out'));
      });
    });
  }

  /**
   * Broadcasts a purge command across the entire cluster.
   */
  public async broadcastPurge(
    purge: ClusterPurgeRequest,
    targetNodes?: string[]
  ): Promise<ClusterPurgeResult> {
    const allNodeIds = targetNodes ?? [this.id, ...Array.from(this.peers.keys())];
    const succeeded: string[] = [];
    const failed: string[] = [];
    let totalPurged = 0;
    const nodeResults = new Map<string, ClusterPurgeResponse>();

    const promises = allNodeIds.map(async (nodeId) => {
      if (nodeId === this.id) {
        try {
          const localRes = this.localPurgeHandler ? await this.localPurgeHandler(purge) : { purgedCount: 0 };
          succeeded.push(this.id);
          totalPurged += localRes.purgedCount;
          nodeResults.set(this.id, {
            nodeId: this.id,
            status: 'ok',
            purgedCount: localRes.purgedCount,
          });
        } catch (err: any) {
          failed.push(this.id);
          nodeResults.set(this.id, {
            nodeId: this.id,
            status: 'error',
            purgedCount: 0,
            error: err.message,
          });
        }
        return;
      }

      const peer = this.peers.get(nodeId);
      if (!peer) {
        failed.push(nodeId);
        nodeResults.set(nodeId, {
          nodeId,
          status: 'error',
          purgedCount: 0,
          error: 'Peer not found',
        });
        return;
      }

      try {
        const res = await this.sendPeerPurge(peer, purge);
        succeeded.push(nodeId);
        totalPurged += res.purgedCount;
        nodeResults.set(nodeId, res);
      } catch (err: any) {
        failed.push(nodeId);
        nodeResults.set(nodeId, {
          nodeId,
          status: 'error',
          purgedCount: 0,
          error: err.message,
        });
      }
    });

    await Promise.all(promises);
    return { succeeded, failed, totalPurged, nodeResults };
  }

  private sendPeerPurge(peer: PeerNodeConfig, purge: ClusterPurgeRequest): Promise<ClusterPurgeResponse> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(purge);
      const req = http.request(
        {
          hostname: peer.host,
          port: peer.port,
          path: '/cluster/purge',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-cdn-cluster-auth': this.sharedSecret,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode === 200 && data.status === 'ok') {
                resolve({
                  nodeId: peer.id,
                  status: 'ok',
                  purgedCount: data.purgedCount ?? 0,
                });
              } else {
                reject(new Error(data.error ?? `Peer purge failed with ${res.statusCode}`));
              }
            } catch (e: any) {
              reject(e);
            }
          });
        }
      );

      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Peer purge timed out')));
      req.end(payload);
    });
  }

  private recordNodeSuccess(nodeId: string): void {
    const state = this.nodeHealth.get(nodeId);
    if (state) {
      state.healthy = true;
      state.consecutiveFailures = 0;
      state.lastSeen = Date.now();
    }
  }

  private recordNodeFailure(nodeId: string): void {
    const state = this.nodeHealth.get(nodeId);
    if (state) {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= (this.config.missedBeatsThreshold ?? 3)) {
        state.healthy = false;
      }
    }
  }

  /**
   * Internal HTTP router for requests arriving on this node's cluster port.
   */
  private handleIncomingPeerRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Endpoint: GET /cluster/ping
    if (url.pathname === '/cluster/ping' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', nodeId: this.id, ringVersion: this.ring.version }));
      return;
    }

    // Inter-node Auth validation
    const authHeader = req.headers['x-cdn-cluster-auth'];
    if (!authHeader || typeof authHeader !== 'string' || !timingSafeEqual(authHeader, this.sharedSecret)) {
      this.metrics.peerErrors.auth++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized cluster peer' }));
      return;
    }

    // Endpoint: POST /cluster/purge
    if (url.pathname === '/cluster/purge' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const purgedCount = this.localPurgeHandler ? (await this.localPurgeHandler(body)).purgedCount : 0;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', nodeId: this.id, purgedCount }));
        } catch (e: any) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: e.message }));
        }
      });
      return;
    }

    // Endpoint: GET /cluster/peer-fill
    if (url.pathname === '/cluster/peer-fill' && req.method === 'GET') {
      this.metrics.peerRequests.received++;
      const rawHop = req.headers['x-cdn-hop-count'];
      const hops = typeof rawHop === 'string' ? parseInt(rawHop, 10) : NaN;

      if (isNaN(hops) || hops < 1 || hops > this.maxHops) {
        this.metrics.peerErrors.loop++;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid hop count: ${rawHop}` }));
        return;
      }

      const key = url.searchParams.get('key');
      if (!key) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing key parameter' }));
        return;
      }

      if (!this.localRequestHandler) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No localRequestHandler configured' }));
        return;
      }

      this.localRequestHandler(key, req.headers)
        .then((result) => {
          this.metrics.peerRequests.served++;
          const headers: Record<string, string> = {
            ...result.headers,
            'x-cdn-served-by': this.id,
            'x-cdn-cluster-hops': String(hops),
          };
          res.writeHead(result.statusCode, headers);
          res.end(result.body);
        })
        .catch((err: any) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
