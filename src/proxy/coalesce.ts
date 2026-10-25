import http from 'node:http';

export interface PassthroughResponse {
  statusCode: number;
  statusMessage?: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
}

export type CoalesceResult =
  | { kind: 'stored' }
  | { kind: 'passthrough'; response: PassthroughResponse }
  | { kind: 'error'; error: any };

export interface InflightWaiter {
  requestId: string;
  resolve: (result: CoalesceResult) => void;
  reject: (err: any) => void;
}

export interface InflightFlight {
  keyHash: string;
  leaderRequestId: string;
  waiters: Map<string, InflightWaiter>;
  createdAt: number;
}

export class RequestCoalescer {
  public readonly flightMap = new Map<string, InflightFlight>();
  public readonly passMarkerMap = new Map<string, number>();
  public readonly enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  /**
   * Checks if an in-flight request exists for this key.
   * If yes, joins as follower. If no, becomes leader.
   */
  public joinOrLead(
    keyHash: string,
    requestId: string
  ):
    | {
        role: 'follower';
        promise: Promise<CoalesceResult>;
        leave: () => void;
      }
    | {
        role: 'leader';
        flight: InflightFlight;
        finish: (result: CoalesceResult) => void;
        abort: (err: any) => void;
        cleanup: () => void;
      } {
    const existing = this.flightMap.get(keyHash);
    if (existing) {
      let resolveFn!: (result: CoalesceResult) => void;
      let rejectFn!: (err: any) => void;
      const promise = new Promise<CoalesceResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      const waiter: InflightWaiter = {
        requestId,
        resolve: resolveFn,
        reject: rejectFn,
      };

      existing.waiters.set(requestId, waiter);

      const leave = () => {
        existing.waiters.delete(requestId);
      };

      return {
        role: 'follower',
        promise,
        leave,
      };
    }

    // Become leader
    const flight: InflightFlight = {
      keyHash,
      leaderRequestId: requestId,
      waiters: new Map(),
      createdAt: Date.now(),
    };
    this.flightMap.set(keyHash, flight);

    let completed = false;

    const cleanup = () => {
      this.flightMap.delete(keyHash);
      this.passMarkerMap.delete(keyHash);
    };

    const finish = (result: CoalesceResult) => {
      if (completed) return;
      completed = true;

      if (result.kind === 'passthrough') {
        this.passMarkerMap.set(keyHash, Date.now());
      }

      for (const waiter of flight.waiters.values()) {
        try {
          waiter.resolve(result);
        } catch {
          // ignore follower resolution errors
        }
      }
      flight.waiters.clear();
      cleanup();
    };

    const abort = (err: any) => {
      if (completed) return;
      completed = true;

      for (const waiter of flight.waiters.values()) {
        try {
          waiter.resolve({ kind: 'error', error: err });
        } catch {
          // ignore follower resolution errors
        }
      }
      flight.waiters.clear();
      cleanup();
    };

    return {
      role: 'leader',
      flight,
      finish,
      abort,
      cleanup,
    };
  }
}
