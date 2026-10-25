import http from 'node:http';
import { pipeline, Transform } from 'node:stream';
import { forwardResponseHeaders } from './response.js';
import { RequestContext } from './context.js';

import { CacheTeeStream } from '../cache/fill.js';

import { Clock } from '../util/clock.js';

export interface StreamResponseOptions {
  requestId?: string;
  context?: RequestContext;
  onUpstreamAbortedMidbody?: (requestId: string, err?: any) => void;
  teeStream?: CacheTeeStream;
  extraHeaders?: Record<string, string | string[]>;
  clock?: Clock;
  responseTimeMs?: number;
  compressor?: any;
  decompressor?: any;
  preserveOriginId?: boolean;
}

/**
 * Streams origin response to client response using stream.pipeline:
 * - Sends headers immediately when received.
 * - Streams body with backpressure without buffering (or with bounded cache tee).
 * - Enforces exact Content-Length validation (overrun abort, underrun drop).
 * - If upstream dies after headers are sent, destroys client socket and logs 'upstream_aborted_midbody'.
 */
export function streamOriginResponse(
  originRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  requestMethod: string,
  options: StreamResponseOptions = {}
): Promise<void> {
  const requestId = options.requestId ?? options.context?.requestId ?? 'unknown';

  return new Promise<void>((resolve, reject) => {
    // 1. Send headers immediately
    const { isBodyless } = forwardResponseHeaders(
      originRes,
      clientRes,
      requestMethod,
      requestId,
      options.extraHeaders,
      options.clock,
      options.responseTimeMs,
      {
        compressor: options.compressor,
        decompressor: options.decompressor,
        preserveOriginId: options.preserveOriginId,
      }
    );

    if (isBodyless) {
      options.teeStream?.finish();
      resolve();
      return;
    }

    if (options.context) {
      options.context.phase = 'streaming_body';
    }

    let pipelineEndedCleanly = false;

    // Handle mid-body abort or premature socket close from upstream
    const handleUpstreamMidbodyAbort = (err?: any) => {
      if (pipelineEndedCleanly) return;
      pipelineEndedCleanly = true;

      // Log upstream_aborted_midbody with request id
      const logMessage = `upstream_aborted_midbody requestId=${requestId}${err?.message ? ` error=${err.message}` : ''}`;
      console.error(logMessage);

      if (options.onUpstreamAbortedMidbody) {
        options.onUpstreamAbortedMidbody(requestId, err);
      }

      // Destroy client socket so client sees truncated/aborted response
      if (clientRes.socket && !clientRes.socket.destroyed) {
        clientRes.socket.destroy();
      } else if (!clientRes.destroyed) {
        clientRes.destroy();
      }

      // Destroy origin socket so origin knows client disconnected
      if (originRes.socket && !originRes.socket.destroyed) {
        originRes.socket.destroy();
      } else if (!originRes.destroyed) {
        originRes.destroy();
      }

      reject(err ?? new Error('Upstream aborted mid-body'));
    };

    // If origin connection is closed prematurely before complete
    originRes.on('close', () => {
      if (!originRes.complete && !pipelineEndedCleanly) {
        handleUpstreamMidbodyAbort(new Error('Origin closed socket prematurely'));
      }
    });

    const onEnd = (err?: any) => {
      if (err) {
        options.teeStream?.abort();
        handleUpstreamMidbodyAbort(err);
      } else {
        const clientAborted = Boolean(
          options.context?.signal?.aborted || options.context?.phase === 'aborted'
        );
        options.teeStream?.finish(clientAborted);
        if (options.context && !clientAborted) {
          options.context.phase = 'completed';
        }
        resolve();
      }
    };

    // Determine expected Content-Length for non-chunked bodies
    const rawTe = originRes.headers['transfer-encoding'];
    let isChunked = false;
    if (typeof rawTe === 'string') {
      isChunked = rawTe.toLowerCase().includes('chunked');
    } else if (Array.isArray(rawTe)) {
      isChunked = (rawTe as string[]).some(
        (t) => typeof t === 'string' && t.toLowerCase().includes('chunked')
      );
    }

    const rawCl = originRes.headers['content-length'];
    let expectedContentLength: number | undefined;
    if (!isChunked && typeof rawCl === 'string' && /^\d+$/.test(rawCl.trim())) {
      expectedContentLength = parseInt(rawCl.trim(), 10);
    }

    let receivedBytes = 0;
    const lengthValidator = new Transform({
      transform(
        chunk: any,
        encoding: BufferEncoding,
        callback: (error?: Error | null, data?: any) => void
      ) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        receivedBytes += buf.length;
        if (expectedContentLength !== undefined && receivedBytes > expectedContentLength) {
          const err = new Error(
            `UPSTREAM_CONTENT_LENGTH_OVERRUN: received ${receivedBytes} bytes, expected ${expectedContentLength}`
          );
          (err as any).code = 'UPSTREAM_OVERRUN';
          callback(err);
          return;
        }
        callback(null, buf);
      },
      flush(callback: (error?: Error | null) => void) {
        if (expectedContentLength !== undefined && receivedBytes < expectedContentLength) {
          const err = new Error(
            `UPSTREAM_CONTENT_LENGTH_UNDERRUN: received ${receivedBytes} bytes, expected ${expectedContentLength}`
          );
          (err as any).code = 'UPSTREAM_UNDERRUN';
          callback(err);
          return;
        }
        callback();
      },
    });

    const streams: any[] = [originRes, lengthValidator];
    if (options.decompressor) {
      streams.push(options.decompressor);
    }
    if (options.teeStream) {
      streams.push(options.teeStream);
    }
    if (options.compressor) {
      streams.push(options.compressor);
    }
    streams.push(clientRes);

    (pipeline as any)(...streams, onEnd);
  });
}
