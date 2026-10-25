/**
 * Circuit Breaker (Feature 61)
 *
 * Implements per-origin circuit breaking with three states:
 * - CLOSED: Normal operation. Requests pass through. Failures are counted.
 * - OPEN: Tripped when consecutive failures reach failureThreshold.
 *   Rejects immediately with zero upstream attempts until openDurationMs elapses.
 * - HALF_OPEN: Entered after openDurationMs. Allows up to halfOpenMaxRequests trial requests.
 *   A successful trial closes the circuit; a failed trial immediately reopens it.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  enabled?: boolean;
  failureThreshold?: number;
  openDurationMs?: number;
  halfOpenMaxRequests?: number;
  clock?: () => number;
}

interface OriginBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenTrialsGranted: number;
}

export class CircuitBreaker {
  private readonly enabled: boolean;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly halfOpenMaxRequests: number;
  private readonly clock: () => number;

  private readonly states = new Map<string, OriginBreakerState>();

  constructor(config: CircuitBreakerConfig = {}) {
    this.enabled = config.enabled !== false;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.openDurationMs = config.openDurationMs ?? 15_000;
    this.halfOpenMaxRequests = config.halfOpenMaxRequests ?? 1;
    this.clock = config.clock ?? Date.now;
  }

  private getStateObj(originId: string): OriginBreakerState {
    let state = this.states.get(originId);
    if (!state) {
      state = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenTrialsGranted: 0,
      };
      this.states.set(originId, state);
    }
    return state;
  }

  public getState(originId: string): CircuitState {
    if (!this.enabled) {
      return 'CLOSED';
    }

    const state = this.getStateObj(originId);
    const now = this.clock();

    // Check if open duration has elapsed to transition to HALF_OPEN
    if (state.state === 'OPEN' && state.openedAt !== null && now - state.openedAt >= this.openDurationMs) {
      state.state = 'HALF_OPEN';
      state.halfOpenTrialsGranted = 0;
    }

    return state.state;
  }

  public allowRequest(originId: string): boolean {
    if (!this.enabled) {
      return true;
    }

    const state = this.getStateObj(originId);
    const now = this.clock();

    if (state.state === 'CLOSED') {
      return true;
    }

    if (state.state === 'OPEN') {
      if (state.openedAt !== null && now - state.openedAt >= this.openDurationMs) {
        // Transition to HALF_OPEN and grant the first trial request
        state.state = 'HALF_OPEN';
        state.halfOpenTrialsGranted = 1;
        return true;
      }
      return false;
    }

    if (state.state === 'HALF_OPEN') {
      if (state.halfOpenTrialsGranted < this.halfOpenMaxRequests) {
        state.halfOpenTrialsGranted += 1;
        return true;
      }
      return false;
    }

    return false;
  }

  public recordSuccess(originId: string): void {
    if (!this.enabled) {
      return;
    }

    const state = this.getStateObj(originId);
    if (state.state === 'HALF_OPEN') {
      // Successful trial closes the circuit
      state.state = 'CLOSED';
      state.consecutiveFailures = 0;
      state.openedAt = null;
      state.halfOpenTrialsGranted = 0;
    } else if (state.state === 'CLOSED') {
      state.consecutiveFailures = 0;
    }
  }

  public recordFailure(originId: string): void {
    if (!this.enabled) {
      return;
    }

    const state = this.getStateObj(originId);
    const now = this.clock();

    if (state.state === 'HALF_OPEN') {
      // Failed trial reopens the circuit
      state.state = 'OPEN';
      state.openedAt = now;
      state.halfOpenTrialsGranted = 0;
    } else if (state.state === 'CLOSED') {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.state = 'OPEN';
        state.openedAt = now;
      }
    } else if (state.state === 'OPEN') {
      // Re-record open timestamp
      state.openedAt = now;
    }
  }

  public reset(originId?: string): void {
    if (originId) {
      this.states.delete(originId);
    } else {
      this.states.clear();
    }
  }
}
