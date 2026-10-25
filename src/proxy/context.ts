import crypto from 'node:crypto';
import type { VerifiedClientCert } from '../tls/types.js';

export type RequestPhase =
  | 'upload'
  | 'receiving'
  | 'parsing'
  | 'connecting'
  | 'waiting_headers'
  | 'streaming_body'
  | 'completed'
  | 'aborted'
  | 'error';

export interface RequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  phase: RequestPhase;
  readonly startedAt: number;
  clientCert?: VerifiedClientCert;
  abort(reason?: string): void;
}

export function createRequestContext(
  incomingRequestId?: string,
  parentSignal?: AbortSignal
): RequestContext {
  const requestId =
    incomingRequestId && incomingRequestId.trim()
      ? incomingRequestId
      : crypto.randomUUID();

  const controller = new AbortController();

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort((parentSignal as any).reason);
    } else {
      parentSignal.addEventListener('abort', () => {
        controller.abort((parentSignal as any).reason);
      });
    }
  }

  const context: RequestContext = {
    requestId,
    signal: controller.signal,
    phase: 'receiving',
    startedAt: Date.now(),
    abort(reason?: string) {
      if (!controller.signal.aborted) {
        controller.abort(reason ?? 'Request aborted');
      }
    },
  };

  return context;
}
