import { Readable, PassThrough } from 'node:stream';
import http from 'node:http';

export interface CollapsedForwarderConfig {
  enabled?: boolean;
  maxFollowerBufferBytes?: number; // default 64 KB
  onSlowFollower?: 'detach' | 'fail'; // default 'detach'
  maxPromotions?: number; // default 3
  releaseConcurrency?: number; // default 10
}

export interface ForwardResult {
  role: 'leader' | 'follower';
  statusCode: number;
  statusMessage?: string;
  headers: http.IncomingHttpHeaders;
  bodyStream: Readable;
  cacheStatus: 'MISS' | 'HIT' | 'BYPASS';
}

export interface ForwardContext {
  requestId: string;
  key: string;
  varyKey?: string;
  rangeHeader?: string;
  isHead?: boolean;
  signal?: AbortSignal;
}

interface FollowerWaitHandle {
  id: string;
  resolve: (res: ForwardResult) => void;
  reject: (err: any) => void;
  stream: PassThrough;
  bufferedBytes: number;
  detached?: boolean;
}

interface InFlightCollapse {
  collapseKey: string;
  leaderRequestId: string;
  createdAt: number;
  promotions: number;
  headersReceived: boolean;
  statusCode?: number;
  statusMessage?: string;
  headers?: http.IncomingHttpHeaders;
  followers: Map<string, FollowerWaitHandle>;
  leaderStream?: Readable;
  bodyChunks: Buffer[];
  isCacheable?: boolean;
  completed: boolean;
  upstreamAborted: boolean;
  fetchFn: () => Promise<{
    statusCode: number;
    statusMessage?: string;
    headers: http.IncomingHttpHeaders;
    stream: Readable;
  }>;
}

export class CollapsedForwarder {
  private readonly inFlight = new Map<string, InFlightCollapse>();
  private readonly config: Required<CollapsedForwarderConfig>;

  constructor(config: CollapsedForwarderConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      maxFollowerBufferBytes: config.maxFollowerBufferBytes ?? 65536, // 64 KB
      onSlowFollower: config.onSlowFollower ?? 'detach',
      maxPromotions: config.maxPromotions ?? 3,
      releaseConcurrency: config.releaseConcurrency ?? 10,
    };
  }

  public get pendingCount(): number {
    return this.inFlight.size;
  }

  public getPendingFlight(collapseKey: string): InFlightCollapse | undefined {
    return this.inFlight.get(collapseKey);
  }

  /**
   * Generates a composite collapse key incorporating cache key, Vary signature, and Range compatibility.
   */
  public getCollapseKey(ctx: ForwardContext): string {
    const varyPart = ctx.varyKey ? `|v:${ctx.varyKey}` : '';
    // If range is present, only full ranges or matching ranges can collapse
    const rangePart = ctx.rangeHeader ? `|r:${ctx.rangeHeader}` : '';
    const headPart = ctx.isHead ? '|m:HEAD' : '|m:GET';
    return `${ctx.key}${varyPart}${rangePart}${headPart}`;
  }

  /**
   * Collapses concurrent requests for identical keys into a single upstream fetch.
   */
  public async fetch(
    ctx: ForwardContext,
    upstreamFetch: () => Promise<{
      statusCode: number;
      statusMessage?: string;
      headers: http.IncomingHttpHeaders;
      stream: Readable;
    }>
  ): Promise<ForwardResult> {
    if (!this.config.enabled) {
      const up = await upstreamFetch();
      return {
        role: 'leader',
        statusCode: up.statusCode,
        statusMessage: up.statusMessage,
        headers: up.headers,
        bodyStream: up.stream,
        cacheStatus: 'MISS',
      };
    }

    const collapseKey = this.getCollapseKey(ctx);
    const existing = this.inFlight.get(collapseKey);

    if (existing && !existing.completed && !existing.upstreamAborted) {
      return this.joinAsFollower(existing, ctx);
    }

    // Lead the forward
    return this.leadForward(collapseKey, ctx, upstreamFetch);
  }

  private leadForward(
    collapseKey: string,
    ctx: ForwardContext,
    fetchFn: () => Promise<{
      statusCode: number;
      statusMessage?: string;
      headers: http.IncomingHttpHeaders;
      stream: Readable;
    }>
  ): Promise<ForwardResult> {
    const flight: InFlightCollapse = {
      collapseKey,
      leaderRequestId: ctx.requestId,
      createdAt: Date.now(),
      promotions: 0,
      headersReceived: false,
      followers: new Map(),
      bodyChunks: [],
      completed: false,
      upstreamAborted: false,
      fetchFn,
    };

    this.inFlight.set(collapseKey, flight);

    return new Promise<ForwardResult>((resolve, reject) => {
      // Execute the upstream fetch
      flight.fetchFn().then(
        (upstream) => {
          flight.headersReceived = true;
          flight.statusCode = upstream.statusCode;
          flight.statusMessage = upstream.statusMessage;
          flight.headers = upstream.headers;

          const cc = String(upstream.headers['cache-control'] || '').toLowerCase();
          flight.isCacheable =
            !cc.includes('no-store') &&
            !cc.includes('private') &&
            upstream.statusCode < 500;

          // Leader tee stream
          const leaderStream = new PassThrough();
          flight.leaderStream = leaderStream;

          // Dispatch headers to all followers currently waiting
          for (const follower of flight.followers.values()) {
            follower.resolve({
              role: 'follower',
              statusCode: flight.statusCode!,
              statusMessage: flight.statusMessage,
              headers: { ...flight.headers },
              bodyStream: follower.stream,
              cacheStatus: 'MISS',
            });
          }

          // Pipe chunks to leader and followers
          upstream.stream.on('data', (chunk: Buffer) => {
            flight.bodyChunks.push(chunk);
            leaderStream.write(chunk);

            for (const follower of flight.followers.values()) {
              if (follower.detached) continue;

              follower.bufferedBytes += chunk.length;
              if (
                follower.bufferedBytes > this.config.maxFollowerBufferBytes &&
                follower.stream.writableLength > this.config.maxFollowerBufferBytes
              ) {
                if (this.config.onSlowFollower === 'fail') {
                  follower.detached = true;
                  follower.stream.destroy(new Error('Follower buffer exceeded'));
                  flight.followers.delete(follower.id);
                  continue;
                } else {
                  // Detach slow follower and let it consume cached chunks
                  follower.detached = true;
                  flight.followers.delete(follower.id);
                  follower.stream.end();
                  continue;
                }
              }

              const ok = follower.stream.write(chunk);
              if (!ok) {
                follower.stream.once('drain', () => {
                  follower.bufferedBytes = 0;
                });
              }
            }
          });

          upstream.stream.on('end', () => {
            flight.completed = true;
            leaderStream.end();
            for (const follower of flight.followers.values()) {
              if (!follower.detached) {
                follower.stream.end();
              }
            }
            this.inFlight.delete(collapseKey);
          });

          upstream.stream.on('error', (err) => {
            flight.upstreamAborted = true;
            leaderStream.destroy(err);
            for (const follower of flight.followers.values()) {
              if (!follower.detached) {
                follower.stream.destroy(err);
              }
            }
            this.inFlight.delete(collapseKey);
          });

          resolve({
            role: 'leader',
            statusCode: upstream.statusCode,
            statusMessage: upstream.statusMessage,
            headers: upstream.headers,
            bodyStream: leaderStream,
            cacheStatus: 'MISS',
          });
        },
        (err) => {
          // Upstream fetch failed before headers
          flight.upstreamAborted = true;
          this.handleLeaderFailure(flight, err);
          reject(err);
        }
      );
    });
  }

  private joinAsFollower(
    flight: InFlightCollapse,
    ctx: ForwardContext
  ): Promise<ForwardResult> {
    const followerStream = new PassThrough();

    return new Promise<ForwardResult>((resolve, reject) => {
      const handle: FollowerWaitHandle = {
        id: ctx.requestId,
        resolve,
        reject,
        stream: followerStream,
        bufferedBytes: 0,
      };

      flight.followers.set(ctx.requestId, handle);

      // If client aborts before completion
      if (ctx.signal) {
        ctx.signal.addEventListener('abort', () => {
          handle.detached = true;
          flight.followers.delete(ctx.requestId);
          followerStream.destroy(ctx.signal?.reason ?? new Error('Aborted'));
        });
      }

      // If headers were already received on leader, immediately catch up the follower
      if (flight.headersReceived && flight.statusCode !== undefined) {
        resolve({
          role: 'follower',
          statusCode: flight.statusCode,
          statusMessage: flight.statusMessage,
          headers: { ...flight.headers },
          bodyStream: followerStream,
          cacheStatus: 'MISS',
        });

        // Write already accumulated body chunks
        for (const chunk of flight.bodyChunks) {
          followerStream.write(chunk);
        }

        if (flight.completed) {
          followerStream.end();
          flight.followers.delete(ctx.requestId);
        }
      }
    });
  }

  private handleLeaderFailure(flight: InFlightCollapse, err: any): void {
    // If we have remaining followers and have not exceeded max promotions, promote oldest
    if (
      flight.followers.size > 0 &&
      flight.promotions < this.config.maxPromotions
    ) {
      const nextEntry = flight.followers.entries().next().value;
      if (!nextEntry) return;
      const [nextLeaderId, nextLeaderHandle] = nextEntry;
      flight.followers.delete(nextLeaderId);
      flight.promotions++;

      // Re-trigger upstream fetch for promoted follower
      this.inFlight.delete(flight.collapseKey);

      this.leadForward(
        flight.collapseKey,
        {
          requestId: nextLeaderId,
          key: flight.collapseKey,
        },
        flight.fetchFn
      ).then(
        (res) => nextLeaderHandle.resolve(res),
        (e) => nextLeaderHandle.reject(e)
      );
    } else {
      // Fan out error to all followers
      for (const follower of flight.followers.values()) {
        follower.reject(err);
      }
      flight.followers.clear();
      this.inFlight.delete(flight.collapseKey);
    }
  }
}
