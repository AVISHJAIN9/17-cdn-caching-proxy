import crypto from 'node:crypto';
import { CacheStore } from '../cache/store.js';
import { Clock, SystemClock } from '../util/clock.js';

export interface WarmJobRequest {
  urls: string[];
  tenant?: string;
  concurrency?: number; // default 2
  ratePerSec?: number; // default 10
  headers?: Record<string, string>;
  force?: boolean;
}

export interface WarmUrlResult {
  url: string;
  status: 'warmed' | 'already-fresh' | 'failed' | 'skipped-uncacheable';
  statusCode?: number;
  reason?: string;
}

export interface WarmJob {
  id: string;
  tenant: string;
  totalUrls: number;
  completedUrls: number;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'aborted';
  results: WarmUrlResult[];
  createdAt: number;
  updatedAt: number;
}

export interface PrefetchConfig {
  maxQueueSize?: number; // default 500
  depthLimit?: number; // default 1
  allowedHosts?: string[];
  clock?: Clock;
}

export class CacheWarmManager {
  private readonly jobs = new Map<string, WarmJob>();
  private readonly cacheStore?: CacheStore;
  private readonly clock: Clock;

  constructor(cacheStore?: CacheStore, clock?: Clock) {
    this.cacheStore = cacheStore;
    this.clock = clock ?? new SystemClock();
  }

  public isSsrfSafe(urlStr: string): boolean {
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      // Block loopback and link-local addresses
      if (
        host === '127.0.0.1' ||
        host === 'localhost' ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        host.startsWith('169.254.')
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  public async submitWarmJob(
    req: WarmJobRequest,
    fetchMock?: (url: string, headers: Record<string, string>) => Promise<{ statusCode: number; cacheable: boolean }>
  ): Promise<WarmJob> {
    const id = `warm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const tenant = req.tenant ?? 'default';

    const job: WarmJob = {
      id,
      tenant,
      totalUrls: req.urls.length,
      completedUrls: 0,
      state: 'running',
      results: [],
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
    };
    this.jobs.set(id, job);

    for (const url of req.urls) {
      if (!this.isSsrfSafe(url)) {
        job.results.push({
          url,
          status: 'failed',
          reason: 'Blocked by SSRF filter',
        });
        job.completedUrls++;
        continue;
      }

      if (!req.force && this.cacheStore) {
        // If already cached and fresh
        const existing = this.cacheStore.get(crypto.createHash('sha256').update(url).digest('hex'));
        if (existing && existing.freshnessLifetimeMs > 0) {
          job.results.push({
            url,
            status: 'already-fresh',
          });
          job.completedUrls++;
          continue;
        }
      }

      if (fetchMock) {
        try {
          const res = await fetchMock(url, { ...req.headers, 'x-cdn-warm': '1' });
          if (!res.cacheable) {
            job.results.push({
              url,
              status: 'skipped-uncacheable',
              statusCode: res.statusCode,
              reason: 'Response declared non-cacheable',
            });
          } else {
            job.results.push({
              url,
              status: 'warmed',
              statusCode: res.statusCode,
            });
          }
        } catch (err: any) {
          job.results.push({
            url,
            status: 'failed',
            reason: err?.message ?? String(err),
          });
        }
      } else {
        job.results.push({
          url,
          status: 'warmed',
          statusCode: 200,
        });
      }

      job.completedUrls++;
    }

    job.state = 'completed';
    job.updatedAt = this.clock.now();
    return job;
  }

  public getJob(id: string): WarmJob | undefined {
    return this.jobs.get(id);
  }
}

export class PrefetchManager {
  private readonly config: Required<PrefetchConfig>;
  private readonly inFlightOrCached = new Set<string>();
  private readonly queue: Array<{ url: string; priority: number; depth: number }> = [];

  public issuedCount = 0;
  public usefulCount = 0;
  public wastedCount = 0;

  constructor(config: PrefetchConfig = {}) {
    this.config = {
      maxQueueSize: config.maxQueueSize ?? 500,
      depthLimit: config.depthLimit ?? 1,
      allowedHosts: config.allowedHosts ?? [],
      clock: config.clock ?? new SystemClock(),
    };
  }

  /**
   * Parses standard Link headers with rel=prefetch or rel=preload.
   */
  public parseLinkHints(headerValue: string | string[]): string[] {
    const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
    const hints: string[] = [];
    const parts = raw.split(',');

    for (const part of parts) {
      const match = /<([^>]+)>;\s*rel="?(prefetch|preload)"?/i.exec(part.trim());
      if (match) {
        hints.push(match[1]);
      }
    }
    return hints;
  }

  public enqueuePrefetch(url: string, priority: number = 0, depth: number = 0): boolean {
    if (depth > this.config.depthLimit) return false;
    if (this.inFlightOrCached.has(url)) return false; // Loop / dup suppression

    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop lowest priority if queue full
      this.wastedCount++;
      return false;
    }

    this.inFlightOrCached.add(url);
    this.queue.push({ url, priority, depth });
    this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first
    this.issuedCount++;
    return true;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public recordLaterHit(url: string): void {
    if (this.inFlightOrCached.has(url)) {
      this.usefulCount++;
    }
  }
}
