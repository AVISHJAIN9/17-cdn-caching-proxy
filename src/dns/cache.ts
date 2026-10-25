import dns from 'node:dns';
import { Clock, SystemClock } from '../util/clock.js';

export interface DnsRecord {
  address: string;
  family: number;
  expiresAt: number;
}

export interface DnsCacheOptions {
  ttlMs?: number;
  refreshAheadMs?: number;
  staleWhileResolvingMs?: number;
  clock?: Clock;
  resolver?: (hostname: string) => Promise<{ address: string; family: number }>;
}

/**
 * In-memory DNS cache with TTL, background proactive refresh, bounded stale fallback,
 * hit/miss metrics, and Node.js Agent lookup compatibility (Features 63 & 64).
 */
export class DnsCache {
  private readonly cache = new Map<string, DnsRecord>();
  private readonly inFlight = new Map<string, Promise<{ address: string; family: number }>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ttlMs: number;
  private readonly refreshAheadMs: number;
  private readonly staleWhileResolvingMs: number;
  private readonly clock: Clock;
  private readonly resolver: (hostname: string) => Promise<{ address: string; family: number }>;
  private hits = 0;
  private misses = 0;

  constructor(options: DnsCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.refreshAheadMs = options.refreshAheadMs ?? 0;
    this.staleWhileResolvingMs = options.staleWhileResolvingMs ?? 0;
    this.clock = options.clock ?? new SystemClock();
    this.resolver =
      options.resolver ??
      (async (hostname: string) => {
        const res = await dns.promises.lookup(hostname);
        return { address: res.address, family: res.family };
      });
  }

  private triggerRefresh(hostname: string): Promise<{ address: string; family: number }> {
    let pending = this.inFlight.get(hostname);
    if (!pending) {
      pending = this.resolver(hostname)
        .then((record) => {
          this.cache.set(hostname, {
            address: record.address,
            family: record.family,
            expiresAt: this.clock.now() + this.ttlMs,
          });
          return record;
        })
        .finally(() => {
          this.inFlight.delete(hostname);
        });

      this.inFlight.set(hostname, pending);
    }
    return pending;
  }

  public async resolve(hostname: string): Promise<{ address: string; family: number }> {
    const now = this.clock.now();
    const existing = this.cache.get(hostname);

    if (existing) {
      // 1. Fresh entry
      if (existing.expiresAt > now) {
        this.hits++;
        // Proactive background refresh ahead of expiry
        if (this.refreshAheadMs > 0 && now >= existing.expiresAt - this.refreshAheadMs) {
          // Trigger background refresh without blocking the caller
          this.triggerRefresh(hostname).catch(() => {});
        }
        return { address: existing.address, family: existing.family };
      }

      // 2. Expired entry, check bounded stale-while-resolving fallback
      if (this.staleWhileResolvingMs > 0 && now < existing.expiresAt + this.staleWhileResolvingMs) {
        try {
          const fresh = await this.triggerRefresh(hostname);
          return fresh;
        } catch (err) {
          // If refresh fails while still within staleWhileResolvingMs, serve last good address
          if (this.clock.now() < existing.expiresAt + this.staleWhileResolvingMs) {
            this.hits++;
            return { address: existing.address, family: existing.family };
          }
          this.cache.delete(hostname);
          throw err;
        }
      }

      // Beyond stale boundary: drop stale entry
      this.cache.delete(hostname);
    }

    // Cache MISS: resolve synchronously
    this.misses++;
    return this.triggerRefresh(hostname);
  }

  public lookup(
    hostname: string,
    options: any,
    callback: (err: any, addressOrAddresses?: any, family?: number) => void
  ): void {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    this.resolve(hostname)
      .then((record) => {
        if (options && options.all) {
          callback(null, [{ address: record.address, family: record.family }]);
        } else {
          callback(null, record.address, record.family);
        }
      })
      .catch((err) => {
        callback(err);
      });
  }

  public scheduleBackgroundRefresh(hostname: string, intervalMs: number = this.ttlMs / 2): void {
    if (this.timers.has(hostname)) {
      clearInterval(this.timers.get(hostname)!);
    }

    const timer = setInterval(() => {
      this.triggerRefresh(hostname).catch(() => {});
    }, intervalMs);

    if (timer.unref) {
      timer.unref();
    }

    this.timers.set(hostname, timer);
  }

  public hasActiveTimers(): boolean {
    return this.timers.size > 0;
  }

  public getStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    };
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public destroy(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.cache.clear();
    this.inFlight.clear();
  }
}
