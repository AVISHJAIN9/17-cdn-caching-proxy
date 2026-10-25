import http from 'node:http';
import { EventEmitter } from 'node:events';
import { RequestContext, RequestPhase } from './context.js';

export interface CancelledEvent {
  event: 'request_cancelled';
  requestId: string;
  phase: RequestPhase;
  reason: string;
}

export const cancellationEvents = new EventEmitter();

export function logRequestCancelled(
  requestId: string,
  phase: RequestPhase,
  reason: string
): void {
  const payload: CancelledEvent = {
    event: 'request_cancelled',
    requestId,
    phase,
    reason,
  };
  console.log(JSON.stringify(payload));
  cancellationEvents.emit('request_cancelled', payload);
}

interface ListenerRecord {
  emitter: EventEmitter;
  event: string;
  listener: (...args: any[]) => void;
}

export class CancellationCoordinator {
  private context: RequestContext;
  private clientReq?: http.IncomingMessage;
  private clientRes?: http.ServerResponse;
  private upstreamReq?: http.ClientRequest;
  private upstreamRes?: http.IncomingMessage;
  private listeners: ListenerRecord[] = [];
  private isCleanedUp = false;

  constructor(
    context: RequestContext,
    clientReq?: http.IncomingMessage,
    clientRes?: http.ServerResponse
  ) {
    this.context = context;
    this.clientReq = clientReq;
    this.clientRes = clientRes;

    this.bindSignal();
    this.bindClient();
  }

  private addListener(
    emitter: EventEmitter,
    event: string,
    listener: (...args: any[]) => void
  ): void {
    emitter.on(event, listener);
    this.listeners.push({ emitter, event, listener });
  }

  private bindSignal(): void {
    const onAbort = () => {
      this.handleAbort((this.context.signal as any).reason || 'aborted');
    };

    if (this.context.signal.aborted) {
      onAbort();
    } else {
      this.context.signal.addEventListener('abort', onAbort, { once: true });
      this.listeners.push({
        emitter: this.context.signal as any,
        event: 'abort',
        listener: onAbort,
      });
    }
  }

  private bindClient(): void {
    if (this.clientReq) {
      const onClientReqClose = () => {
        // If request stream closed before complete or response ended, client aborted
        if (!this.clientReq?.complete && !this.clientRes?.writableEnded) {
          this.context.abort('client_aborted_upload');
        }
      };

      const onClientReqAborted = () => {
        this.context.abort('client_aborted');
      };

      this.addListener(this.clientReq, 'close', onClientReqClose);
      this.addListener(this.clientReq, 'aborted', onClientReqAborted);
      if (this.clientReq.socket) {
        this.addListener(this.clientReq.socket, 'close', onClientReqClose);
      }
    }

    if (this.clientRes) {
      const onClientResClose = () => {
        if (!this.clientRes?.writableEnded) {
          this.context.abort('client_disconnect');
        } else {
          this.cleanup();
        }
      };

      const onClientResFinish = () => {
        this.context.phase = 'completed';
        this.cleanup();
      };

      this.addListener(this.clientRes, 'close', onClientResClose);
      this.addListener(this.clientRes, 'finish', onClientResFinish);
      if (this.clientRes.socket) {
        this.addListener(this.clientRes.socket, 'close', onClientResClose);
      }
    }
  }

  public setUpstreamRequest(req: http.ClientRequest): void {
    this.upstreamReq = req;

    // Ensure errors on upstreamReq are captured if destroyed
    const onUpstreamError = (_err: any) => {
      // Handled or ignored
    };
    this.addListener(req, 'error', onUpstreamError);

    // If signal is already aborted, destroy immediately
    if (this.context.signal.aborted) {
      this.destroyUpstream((this.context.signal as any).reason || 'aborted');
    }
  }

  public setUpstreamResponse(res: http.IncomingMessage): void {
    this.upstreamRes = res;

    const onUpstreamResClose = () => {
      if (!res.complete && this.context.phase === 'streaming_body') {
        // Handled by stream pipeline or idle timeout
      }
    };
    this.addListener(res, 'close', onUpstreamResClose);

    if (this.context.signal.aborted) {
      this.destroyUpstream((this.context.signal as any).reason || 'aborted');
    }
  }

  public setPhase(phase: RequestPhase): void {
    if (this.context.phase !== 'aborted' && this.context.phase !== 'completed') {
      this.context.phase = phase;
    }
  }

  private handleAbort(reason: string): void {
    if (this.isCleanedUp) return;

    const phase = this.context.phase;
    this.context.phase = 'aborted';

    logRequestCancelled(this.context.requestId, phase, reason);

    this.destroyClient(reason);
    this.destroyUpstream(reason);
    this.cleanup();
  }

  private destroyClient(_reason: string): void {
    if (this.clientReq) {
      try {
        this.clientReq.unpipe();
        this.clientReq.pause();
        if (!this.clientReq.destroyed) {
          this.clientReq.destroy();
        }
      } catch {
        // ignore
      }
    }

    if (this.clientRes) {
      try {
        if (!this.clientRes.writableEnded && !this.clientRes.destroyed) {
          this.clientRes.destroy();
        }
      } catch {
        // ignore
      }
    }
  }

  private destroyUpstream(reason: string): void {
    if (this.upstreamReq) {
      try {
        if (this.upstreamReq.socket && !this.upstreamReq.socket.destroyed) {
          this.upstreamReq.socket.destroy();
        }
        if (!this.upstreamReq.destroyed) {
          this.upstreamReq.destroy(new Error(`Request cancelled: ${reason}`));
        }
      } catch {
        // ignore
      }
    }

    if (this.upstreamRes) {
      try {
        if (this.upstreamRes.socket && !this.upstreamRes.socket.destroyed) {
          this.upstreamRes.socket.destroy();
        }
        if (!this.upstreamRes.destroyed) {
          this.upstreamRes.destroy();
        }
      } catch {
        // ignore
      }
    }
  }

  public cleanup(): void {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;

    for (const { emitter, event, listener } of this.listeners) {
      try {
        if (typeof (emitter as any).removeEventListener === 'function') {
          (emitter as any).removeEventListener(event, listener);
        } else if (typeof emitter.removeListener === 'function') {
          emitter.removeListener(event, listener);
        }
      } catch {
        // ignore
      }
    }
    this.listeners = [];
  }
}
