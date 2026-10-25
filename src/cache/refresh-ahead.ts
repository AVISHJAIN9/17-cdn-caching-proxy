import { Clock, SystemClock } from '../util/clock.js';
import { CacheEntry } from './store.js';

export interface RefreshAheadConfig {
  enabled?: boolean;
  refreshFactor?: number; // default 0.2 (refresh when remaining TTL < 20%)
  minHits?: number; // default 3 hits to qualify as hot key
  maxConcurrentRefreshes?: number; // default 5
  jitterRatio?: number; // default 0.1 (±10%)
  clock?: Clock;
}

export interface RefreshAheadStats {
  refreshesTriggered: number;
  refreshesCompleted: number;
  refreshesFailed: number;
  refreshesSkippedCircuit: number;
  refreshesSkippedCapacity: number;
}

export class RefreshAheadManager {
  public readonly config: Required<RefreshAheadConfig>;
  private readonly clock: Clock;
  private readonly hitCounts = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  private stats: RefreshAheadStats = {
    refreshesTriggered: 0,
    refreshesCompleted: 0,
    refreshesFailed: 0,
    refreshesSkippedCircuit: 0,
    refreshesSkippedCapacity: 0,
  };

  constructor(config: RefreshAheadConfig = {}) {
    this.clock = config.clock ?? new SystemClock();
    this.config = {
      enabled: config.enabled ?? true,
      refreshFactor: config.refreshFactor ?? 0.2,
      minHits: config.minHits ?? 3,
      maxConcurrentRefreshes: config.maxConcurrentRefreshes ?? 5,
      jitterRatio: config.jitterRatio ?? 0.1,
      clock: this.clock,
    };
  }

  public getStats(): RefreshAheadStats {
    return { ...this.stats };
  }

  public getInFlightCount(): number {
    return this.inFlight.size;
  }

  public recordHit(key: string): number {
    const hits = (this.hitCounts.get(key) ?? 0) + 1;
    this.hitCounts.set(key, hits);
    return hits;
  }

  public getHitCount(key: string): number {
    return this.hitCounts.get(key) ?? 0;
  }

  /**
   * Evaluates if a key is eligible for proactive refresh-ahead.
   */
  public maybeTriggerRefresh(params: {
    key: string;
    entry: CacheEntry;
    revalidateFn: () => Promise<boolean>;
    isCircuitOpen?: () => boolean;
  }): boolean {
    if (!this.config.enabled) return false;

    const hits = this.recordHit(params.key);
    if (hits < this.config.minHits) {
      return false; // Cold key
    }

    const now = this.clock.now();
    const totalTtl = params.entry.freshnessLifetimeMs;
    if (totalTtl <= 0) return false;

    const age = now - params.entry.storedAt;
    const remaining = totalTtl - age;
    const remainingRatio = remaining / totalTtl;

    // Must be within refresh window (remaining TTL < refreshFactor)
    if (remainingRatio >= this.config.refreshFactor || remaining <= 0) {
      return false;
    }

    // Coalesce: already in-flight
    if (this.inFlight.has(params.key)) {
      return false;
    }

    // Circuit breaker check
    if (params.isCircuitOpen && params.isCircuitOpen()) {
      this.stats.refreshesSkippedCircuit++;
      return false;
    }

    // Concurrency throttle
    if (this.inFlight.size >= this.config.maxConcurrentRefreshes) {
      this.stats.refreshesSkippedCapacity++;
      return false;
    }

    // Mark in-flight
    this.inFlight.add(params.key);
    this.stats.refreshesTriggered++;

    // Execute refresh asynchronously with jitter
    const jitterMax = remaining * this.config.jitterRatio;
    const jitter = (Math.random() * 2 - 1) * jitterMax;
    const delay = Math.max(0, Math.floor(jitter));

    const execute = async () => {
      try {
        const success = await params.revalidateFn();
        if (success) {
          this.stats.refreshesCompleted++;
        } else {
          this.stats.refreshesFailed++;
        }
      } catch {
        this.stats.refreshesFailed++;
      } finally {
        this.inFlight.delete(params.key);
      }
    };

    if (delay > 0 && typeof (this.clock as any).setTimeout === 'function') {
      (this.clock as any).setTimeout(execute, delay);
    } else {
      execute();
    }

    return true;
  }
}
