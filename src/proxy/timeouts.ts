import http from 'node:http';
import { sendJsonError } from './request.js';
import { RequestContext } from './context.js';

export interface TimeoutConfig {
  upstreamConnectMs?: number; // default 5000: TCP connect + TLS handshake
  upstreamHeadersMs?: number; // default 30000: time to receive response headers
  upstreamIdleMs?: number; // default 60000: max gap between body chunks
  clientHeadersMs?: number; // default 10000: slow-client headers protection
  clientRequestMs?: number; // default 300000: slow-client request protection
  keepAliveTimeoutMs?: number; // default 5000: client keep-alive timeout
  totalRequestMs?: number; // default 0: overall deadline (0 = disabled)
}

export const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  upstreamConnectMs: 5000,
  upstreamHeadersMs: 30000,
  upstreamIdleMs: 60000,
  clientHeadersMs: 10000,
  clientRequestMs: 300000,
  keepAliveTimeoutMs: 5000,
  totalRequestMs: 0,
};

export class TimeoutManager {
  private config: Required<TimeoutConfig>;

  constructor(config: TimeoutConfig = {}) {
    this.config = {
      upstreamConnectMs: config.upstreamConnectMs ?? DEFAULT_TIMEOUTS.upstreamConnectMs,
      upstreamHeadersMs: config.upstreamHeadersMs ?? DEFAULT_TIMEOUTS.upstreamHeadersMs,
      upstreamIdleMs: config.upstreamIdleMs ?? DEFAULT_TIMEOUTS.upstreamIdleMs,
      clientHeadersMs: config.clientHeadersMs ?? DEFAULT_TIMEOUTS.clientHeadersMs,
      clientRequestMs: config.clientRequestMs ?? DEFAULT_TIMEOUTS.clientRequestMs,
      keepAliveTimeoutMs: config.keepAliveTimeoutMs ?? DEFAULT_TIMEOUTS.keepAliveTimeoutMs,
      totalRequestMs: config.totalRequestMs ?? DEFAULT_TIMEOUTS.totalRequestMs,
    };
  }

  public getConfig(): Required<TimeoutConfig> {
    return { ...this.config };
  }

  /**
   * Applies client timeouts (slowloris protection) to an HTTP/HTTPS server instance:
   * Sets headersTimeout, requestTimeout, keepAliveTimeout, and guards connection parsing deadline.
   */
  public applyServerTimeouts(server: http.Server): void {
    server.headersTimeout = this.config.clientHeadersMs;
    server.requestTimeout = this.config.clientRequestMs;
    server.keepAliveTimeout = this.config.keepAliveTimeoutMs;

    const limitMs = this.config.clientHeadersMs;
    if (limitMs > 0) {
      server.on('connection', (socket) => {
        let headersCompleted = false;

        const timer = setTimeout(() => {
          if (!headersCompleted && !socket.destroyed) {
            socket.destroy(new Error('clientHeadersMs timeout'));
          }
        }, limitMs);

        socket.once('close', () => clearTimeout(timer));

        const onRequest = (req: http.IncomingMessage) => {
          if (req.socket === socket) {
            headersCompleted = true;
            clearTimeout(timer);
            server.removeListener('request', onRequest);
          }
        };

        server.on('request', onRequest);
      });
    }
  }

  /**
   * Arm timeouts for an upstream request:
   * - Connect timeout (upstreamConnectMs -> 504 UPSTREAM_CONNECT_TIMEOUT)
   * - Headers timeout (upstreamHeadersMs -> 504 UPSTREAM_HEADERS_TIMEOUT)
   * - Idle timeout (upstreamIdleMs -> destroy client socket UPSTREAM_IDLE_TIMEOUT)
   * - Total request timeout if enabled
   */
  public armUpstreamRequest(
    upstreamReq: http.ClientRequest,
    clientRes: http.ServerResponse,
    requestId: string,
    context?: RequestContext
  ): {
    onHeadersReceived: (originRes: http.IncomingMessage) => void;
    clear: () => void;
  } {
    // Ensure an error listener is present so destroying with an error doesn't cause uncaught exceptions
    if (upstreamReq.listenerCount('error') === 0) {
      upstreamReq.on('error', () => {});
    }

    let connectTimer: NodeJS.Timeout | undefined;
    let headersTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let headersReceived = false;

    // 1. Upstream Connect Timeout
    if (this.config.upstreamConnectMs > 0) {
      connectTimer = setTimeout(() => {
        if (headersReceived) return;
        if (context) context.phase = 'error';

        upstreamReq.destroy(new Error('Upstream connect timeout'));

        if (!clientRes.headersSent) {
          sendJsonError(
            clientRes,
            504,
            'UPSTREAM_CONNECT_TIMEOUT',
            `Connection to upstream timed out after ${this.config.upstreamConnectMs}ms`,
            requestId
          );
        }
      }, this.config.upstreamConnectMs);

      upstreamReq.once('socket', (socket) => {
        if (!socket.connecting) {
          clearTimeout(connectTimer);
          return;
        }

        const isTls = (socket as any).encrypted;
        const eventName = isTls ? 'secureConnect' : 'connect';

        socket.once(eventName, () => {
          clearTimeout(connectTimer);
        });
      });
    }

    // 2. Upstream Headers Timeout
    if (this.config.upstreamHeadersMs > 0) {
      headersTimer = setTimeout(() => {
        if (headersReceived) return;
        if (context) context.phase = 'error';

        upstreamReq.destroy(new Error('Upstream headers timeout'));

        if (!clientRes.headersSent) {
          sendJsonError(
            clientRes,
            504,
            'UPSTREAM_HEADERS_TIMEOUT',
            `Upstream headers timed out after ${this.config.upstreamHeadersMs}ms`,
            requestId
          );
        }
      }, this.config.upstreamHeadersMs);
    }

    // 3. Total Request Timeout
    if (this.config.totalRequestMs > 0) {
      totalTimer = setTimeout(() => {
        if (context) context.phase = 'error';

        upstreamReq.destroy(new Error('Total request timeout'));

        if (!clientRes.headersSent) {
          sendJsonError(
            clientRes,
            504,
            'TOTAL_REQUEST_TIMEOUT',
            `Request exceeded total deadline of ${this.config.totalRequestMs}ms`,
            requestId
          );
        } else {
          clientRes.destroy();
        }
      }, this.config.totalRequestMs);
    }

    const clear = () => {
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    };

    const onHeadersReceived = (originRes: http.IncomingMessage) => {
      headersReceived = true;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);

      // 4. Upstream Idle Timeout (gap between body chunks)
      if (this.config.upstreamIdleMs > 0) {
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            const logMsg = `upstream_aborted_midbody requestId=${requestId} code=UPSTREAM_IDLE_TIMEOUT`;
            console.error(logMsg);

            originRes.destroy(new Error('Upstream idle timeout'));
            if (clientRes.socket && !clientRes.socket.destroyed) {
              clientRes.socket.destroy();
            } else {
              clientRes.destroy();
            }
          }, this.config.upstreamIdleMs);
        };

        resetIdleTimer();
        originRes.on('data', resetIdleTimer);
        originRes.once('end', () => clearTimeout(idleTimer));
        originRes.once('close', () => clearTimeout(idleTimer));
      }
    };

    return { onHeadersReceived, clear };
  }
}
