/**
 * Passive Health Checks (Feature 60)
 *
 * Tracks live request outcomes per origin without dedicated polling:
 * - 5xx errors, timeouts, connection errors, DNS/TLS failures count as origin failures.
 * - Client aborts and 4xx status codes are ignored (not counted as origin failures).
 * - N consecutive failures within a sliding time window mark the origin unhealthy.
 * - Successful responses (2xx/3xx) reset the consecutive failure counter.
 * - An unhealthy origin automatically recovers after a configurable cooldown period.
 */

export interface PassiveHealthConfig {
  enabled?: boolean;
  consecutiveFailures?: number;
  failureWindowMs?: number;
  cooldownMs?: number;
  clock?: () => number;
}

export interface OutcomeParams {
  status?: number;
  code?: string;
  clientAbort?: boolean;
}

const ORIGIN_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'UPSTREAM_CONNECT_TIMEOUT',
  'UPSTREAM_HEADERS_TIMEOUT',
  'UPSTREAM_IDLE_TIMEOUT',
  'UPSTREAM_TLS_ERROR',
  'ETIMEDOUT',
  'UPSTREAM_INVALID_RESPONSE',
]);

export function isOriginFailure(params: OutcomeParams): boolean {
  if (params.clientAbort) {
    return false;
  }
  if (params.code === 'CLIENT_ABORTED' || params.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return false;
  }
  if (params.status !== undefined && params.status >= 500 && params.status <= 599) {
    return true;
  }
  if (params.code && ORIGIN_FAILURE_CODES.has(params.code)) {
    return true;
  }
  return false;
}

interface OriginHealthState {
  failureTimestamps: number[];
  consecutiveFailures: number;
  unhealthyAt: number | null;
}

export class PassiveHealthChecker {
  private readonly enabled: boolean;
  private readonly consecutiveFailuresThreshold: number;
  private readonly failureWindowMs: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  private readonly states = new Map<string, OriginHealthState>();

  constructor(config: PassiveHealthConfig = {}) {
    this.enabled = config.enabled !== false;
    this.consecutiveFailuresThreshold = config.consecutiveFailures ?? 3;
    this.failureWindowMs = config.failureWindowMs ?? 30_000;
    this.cooldownMs = config.cooldownMs ?? 10_000;
    this.clock = config.clock ?? Date.now;
  }

  private getState(originId: string): OriginHealthState {
    let state = this.states.get(originId);
    if (!state) {
      state = {
        failureTimestamps: [],
        consecutiveFailures: 0,
        unhealthyAt: null,
      };
      this.states.set(originId, state);
    }
    return state;
  }

  private pruneWindow(state: OriginHealthState, now: number): void {
    const cutoff = now - this.failureWindowMs;
    while (state.failureTimestamps.length > 0 && state.failureTimestamps[0] < cutoff) {
      state.failureTimestamps.shift();
    }
    if (state.failureTimestamps.length === 0) {
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures = Math.min(state.consecutiveFailures, state.failureTimestamps.length);
    }
  }

  public recordOutcome(originId: string, outcome: OutcomeParams): void {
    if (!this.enabled) {
      return;
    }

    const state = this.getState(originId);
    const now = this.clock();

    // Check if cooldown has elapsed
    if (state.unhealthyAt !== null && now - state.unhealthyAt >= this.cooldownMs) {
      state.unhealthyAt = null;
      state.consecutiveFailures = 0;
      state.failureTimestamps = [];
    }

    if (isOriginFailure(outcome)) {
      this.pruneWindow(state, now);
      state.failureTimestamps.push(now);
      state.consecutiveFailures += 1;

      if (state.consecutiveFailures >= this.consecutiveFailuresThreshold) {
        state.unhealthyAt = now;
      }
    } else if (outcome.status !== undefined && outcome.status >= 200 && outcome.status < 400) {
      // Success resets consecutive failures
      state.consecutiveFailures = 0;
      state.failureTimestamps = [];
    }
    // 4xx or client aborts are neutral: do not increment or reset failures
  }

  public isHealthy(originId: string): boolean {
    if (!this.enabled) {
      return true;
    }

    const state = this.getState(originId);
    const now = this.clock();

    if (state.unhealthyAt !== null) {
      if (now - state.unhealthyAt >= this.cooldownMs) {
        // Cooldown period elapsed, mark healthy again
        state.unhealthyAt = null;
        state.consecutiveFailures = 0;
        state.failureTimestamps = [];
        return true;
      }
      return false;
    }

    this.pruneWindow(state, now);
    return state.consecutiveFailures < this.consecutiveFailuresThreshold;
  }

  public getConsecutiveFailures(originId: string): number {
    const state = this.getState(originId);
    this.pruneWindow(state, this.clock());
    return state.consecutiveFailures;
  }

  public reset(originId?: string): void {
    if (originId) {
      this.states.delete(originId);
    } else {
      this.states.clear();
    }
  }
}
