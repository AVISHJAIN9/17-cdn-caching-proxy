import http from 'node:http';
import https from 'node:https';

/**
 * Active Health Checks (Feature 59)
 *
 * Runs background health probes against configured origins:
 * - Probes run at a configurable interval and stop cleanly on shutdown.
 * - Both healthy and unhealthy thresholds apply (hysteresis: one result never flips state).
 * - Probe timeouts count as failures.
 * - Probes for the same origin never overlap.
 * - Probes never touch the cache store or affect cache keys.
 */

export interface ActiveHealthOriginConfig {
  url: string;
  path?: string;
}

export interface ActiveHealthCheckConfig {
  origins: Record<string, ActiveHealthOriginConfig>;
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  path?: string;
  expectedStatus?: number | number[];
  healthyThreshold?: number;
  unhealthyThreshold?: number;
  sendProbe?: (originId: string, url: string, timeoutMs: number) => Promise<{ status?: number; error?: any }>;
}

interface OriginProbeState {
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  inFlight: boolean;
}

export class ActiveHealthChecker {
  private readonly origins: Record<string, ActiveHealthOriginConfig>;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultPath: string;
  private readonly expectedStatuses: Set<number>;
  private readonly healthyThreshold: number;
  private readonly unhealthyThreshold: number;
  private readonly sendProbeFn?: (originId: string, url: string, timeoutMs: number) => Promise<{ status?: number; error?: any }>;

  private readonly states = new Map<string, OriginProbeState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(config: ActiveHealthCheckConfig) {
    this.origins = config.origins;
    this.enabled = config.enabled !== false;
    this.intervalMs = config.intervalMs ?? 10_000;
    this.timeoutMs = config.timeoutMs ?? 2_000;
    this.defaultPath = config.path ?? '/healthz';

    const expected = config.expectedStatus ?? 200;
    this.expectedStatuses = new Set(Array.isArray(expected) ? expected : [expected]);

    this.healthyThreshold = config.healthyThreshold ?? 2;
    this.unhealthyThreshold = config.unhealthyThreshold ?? 3;
    this.sendProbeFn = config.sendProbe;

    // Initialize state per origin
    for (const originId of Object.keys(this.origins)) {
      this.states.set(originId, {
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        inFlight: false,
      });
    }
  }

  private getState(originId: string): OriginProbeState {
    let state = this.states.get(originId);
    if (!state) {
      state = {
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        inFlight: false,
      };
      this.states.set(originId, state);
    }
    return state;
  }

  public isHealthy(originId: string): boolean {
    if (!this.enabled) {
      return true;
    }
    const state = this.states.get(originId);
    return state ? state.healthy : true;
  }

  public getConsecutiveFailures(originId: string): number {
    return this.getState(originId).consecutiveFailures;
  }

  public getConsecutiveSuccesses(originId: string): number {
    return this.getState(originId).consecutiveSuccesses;
  }

  private async defaultHttpProbe(urlStr: string, timeoutMs: number): Promise<{ status?: number; error?: any }> {
    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(urlStr);
      } catch (err) {
        return resolve({ error: err });
      }

      const client = url.protocol === 'https:' ? https : http;
      let settled = false;

      const req = client.request(
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'CDN-Health-Checker/1.0',
            'Connection': 'close',
          },
        },
        (res) => {
          res.resume(); // consume body without caching
          if (!settled) {
            settled = true;
            resolve({ status: res.statusCode });
          }
        }
      );

      req.setTimeout(timeoutMs, () => {
        if (!settled) {
          settled = true;
          req.destroy(new Error('Probe timeout'));
          const err: any = new Error('Probe timed out');
          err.code = 'ETIMEDOUT';
          resolve({ error: err });
        }
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          resolve({ error: err });
        }
      });

      req.end();
    });
  }

  public async probeOrigin(originId: string): Promise<boolean> {
    const state = this.getState(originId);
    if (state.inFlight) {
      // Avoid overlapping probes
      return state.healthy;
    }

    state.inFlight = true;

    try {
      const originCfg = this.origins[originId];
      if (!originCfg) {
        return state.healthy;
      }

      const probePath = originCfg.path ?? this.defaultPath;
      const originUrl = new URL(originCfg.url);
      const targetUrl = new URL(probePath, originUrl).toString();

      let probeResult: { status?: number; error?: any };
      if (this.sendProbeFn) {
        probeResult = await this.sendProbeFn(originId, targetUrl, this.timeoutMs);
      } else {
        probeResult = await this.defaultHttpProbe(targetUrl, this.timeoutMs);
      }

      const isSuccess =
        !probeResult.error &&
        probeResult.status !== undefined &&
        this.expectedStatuses.has(probeResult.status);

      if (isSuccess) {
        state.consecutiveFailures = 0;
        state.consecutiveSuccesses += 1;
        if (!state.healthy && state.consecutiveSuccesses >= this.healthyThreshold) {
          state.healthy = true;
        }
      } else {
        state.consecutiveSuccesses = 0;
        state.consecutiveFailures += 1;
        if (state.healthy && state.consecutiveFailures >= this.unhealthyThreshold) {
          state.healthy = false;
        }
      }

      return state.healthy;
    } finally {
      state.inFlight = false;
    }
  }

  public start(): void {
    if (this.running || !this.enabled) {
      return;
    }
    this.running = true;

    for (const originId of Object.keys(this.origins)) {
      const timer = setInterval(() => {
        this.probeOrigin(originId).catch(() => {});
      }, this.intervalMs);

      // Unref timer so it does not hold the Node process open
      if (timer.unref) {
        timer.unref();
      }

      this.timers.set(originId, timer);
    }
  }

  public stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
