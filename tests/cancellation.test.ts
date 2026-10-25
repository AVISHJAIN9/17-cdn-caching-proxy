import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { ProxyListener } from '../src/proxy/listener.js';
import { createRequestContext } from '../src/proxy/context.js';
import { UpstreamClient } from '../src/proxy/upstream.js';
import {
  CancellationCoordinator,
  cancellationEvents,
  CancelledEvent,
} from '../src/proxy/cancellation.js';
import { streamOriginResponse } from '../src/proxy/stream.js';

describe('Feature 5: Cancellation', () => {
  let originServer: http.Server;
  let originPort: number;
  let proxyListener: ProxyListener;
  let proxyPort: number;
  let upstreamClient: UpstreamClient;

  // Track closures on origin
  let uploadClosedAt = 0;
  let connectingClosedAt = 0;
  let waitingHeadersClosedAt = 0;
  let streamingBodyClosedAt = 0;
  let uploadBytesReceived = 0;

  beforeAll(async () => {
    upstreamClient = new UpstreamClient({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
    });

    originServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname === '/upload-slow') {
        req.on('data', (chunk) => {
          uploadBytesReceived += chunk.length;
        });
        const onClose = () => {
          uploadClosedAt = Date.now();
        };
        req.on('close', onClose);
        req.socket.on('close', onClose);
        return;
      }

      if (url.pathname === '/connecting-test') {
        const onClose = () => {
          connectingClosedAt = Date.now();
        };
        req.on('close', onClose);
        req.socket.on('close', onClose);
        // Do not respond
        return;
      }

      if (url.pathname === '/wait-headers') {
        const onClose = () => {
          waitingHeadersClosedAt = Date.now();
        };
        req.on('close', onClose);
        req.socket.on('close', onClose);
        // Never reply
        return;
      }

      if (url.pathname === '/stream-body') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked',
        });
        res.write('first chunk\n');
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }

        const interval = setInterval(() => {
          try {
            res.write('another chunk\n');
          } catch {
            clearInterval(interval);
          }
        }, 50);

        const onClose = () => {
          clearInterval(interval);
          streamingBodyClosedAt = Date.now();
        };
        req.on('close', onClose);
        req.socket.on('close', onClose);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        originPort = (originServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    proxyListener = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        shutdownGracePeriodMs: 500,
        handleSignals: false,
      },
      (clientReq, clientRes) => {
        const ctx = createRequestContext(clientReq.headers['x-request-id'] as string | undefined);
        proxyListener.registerContext(ctx);

        const coordinator = new CancellationCoordinator(ctx, clientReq, clientRes);

        const isUpload = clientReq.method === 'POST' || clientReq.method === 'PUT';
        if (isUpload) {
          coordinator.setPhase('upload');
        } else {
          coordinator.setPhase('connecting');
        }

        const url = new URL(clientReq.url ?? '/', `http://127.0.0.1:${originPort}`);

        const upstreamReq = upstreamClient.request(
          {
            url,
            method: clientReq.method ?? 'GET',
            headers: clientReq.headers as http.OutgoingHttpHeaders,
            signal: ctx.signal,
          },
          (originRes) => {
            coordinator.setUpstreamResponse(originRes);
            coordinator.setPhase('streaming_body');

            streamOriginResponse(
              originRes,
              clientRes,
              clientReq.method ?? 'GET',
              {
                requestId: ctx.requestId,
                context: ctx,
                onUpstreamAbortedMidbody: () => {
                  coordinator.setPhase('aborted');
                },
              }
            ).catch(() => {});
          },
          (_err) => {
            // Handled by cancellation coordinator
          }
        );

        coordinator.setUpstreamRequest(upstreamReq);

        upstreamReq.on('socket', (sock) => {
          if (!sock.connecting) {
            if (!isUpload && ctx.phase === 'connecting' && clientReq.url !== '/connecting-test') {
              coordinator.setPhase('waiting_headers');
            }
          } else {
            sock.once('connect', () => {
              if (!isUpload && ctx.phase === 'connecting' && clientReq.url !== '/connecting-test') {
                coordinator.setPhase('waiting_headers');
              }
            });
          }
        });

        if (isUpload) {
          clientReq.pipe(upstreamReq);
        } else {
          upstreamReq.end();
        }
      }
    );

    await proxyListener.start();
    proxyPort = proxyListener.httpPort!;
  });

  afterAll(async () => {
    await proxyListener.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
    upstreamClient.destroy();
  });

  it('phase 1: client aborts during upload and origin connection closes within ~300ms', async () => {
    uploadClosedAt = 0;
    uploadBytesReceived = 0;

    const cancelledPromise = new Promise<CancelledEvent>((resolve) => {
      const listener = (event: CancelledEvent) => {
        if (event.phase === 'upload') {
          cancellationEvents.removeListener('request_cancelled', listener);
          resolve(event);
        }
      };
      cancellationEvents.on('request_cancelled', listener);
    });

    const clientSocket = net.connect(proxyPort, '127.0.0.1', () => {
      clientSocket.write(
        'POST /upload-slow HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          'Transfer-Encoding: chunked\r\n' +
          '\r\n' +
          '5\r\n' +
          'hello\r\n'
      );

      // Abort after 50ms while upload is still in progress
      setTimeout(() => {
        clientSocket.destroy();
      }, 50);
    });
    clientSocket.on('error', () => {});

    const event = await cancelledPromise;
    expect(event.phase).toBe('upload');

    // Wait up to 350ms for origin to close
    const start = Date.now();
    while (uploadClosedAt === 0 && Date.now() - start < 400) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(uploadClosedAt).toBeGreaterThan(0);
    expect(uploadClosedAt - start).toBeLessThan(350);
  });

  it('phase 2: client aborts while connecting upstream and connection closes within ~300ms', async () => {
    connectingClosedAt = 0;

    const cancelledPromise = new Promise<CancelledEvent>((resolve) => {
      const listener = (event: CancelledEvent) => {
        if (event.phase === 'connecting') {
          cancellationEvents.removeListener('request_cancelled', listener);
          resolve(event);
        }
      };
      cancellationEvents.on('request_cancelled', listener);
    });

    const clientSocket = net.connect(proxyPort, '127.0.0.1', () => {
      clientSocket.write(
        'GET /connecting-test HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          'Connection: close\r\n' +
          '\r\n'
      );

      // Abort after 20ms while in connecting phase
      setTimeout(() => {
        clientSocket.destroy();
      }, 20);
    });
    clientSocket.on('error', () => {});

    const event = await cancelledPromise;
    expect(event.phase).toBe('connecting');

    const start = Date.now();
    while (connectingClosedAt === 0 && Date.now() - start < 400) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(connectingClosedAt).toBeGreaterThan(0);
    expect(connectingClosedAt - start).toBeLessThan(350);
  });

  it('phase 3: client aborts while waiting for headers and origin connection closes within ~300ms', async () => {
    waitingHeadersClosedAt = 0;

    const cancelledPromise = new Promise<CancelledEvent>((resolve) => {
      const listener = (event: CancelledEvent) => {
        if (event.phase === 'waiting_headers') {
          cancellationEvents.removeListener('request_cancelled', listener);
          resolve(event);
        }
      };
      cancellationEvents.on('request_cancelled', listener);
    });

    const clientSocket = net.connect(proxyPort, '127.0.0.1', () => {
      clientSocket.write(
        'GET /wait-headers HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          '\r\n'
      );

      // Wait 60ms so upstream connects and enters waiting_headers
      setTimeout(() => {
        clientSocket.destroy();
      }, 60);
    });
    clientSocket.on('error', () => {});

    const event = await cancelledPromise;
    expect(event.phase).toBe('waiting_headers');

    const start = Date.now();
    while (waitingHeadersClosedAt === 0 && Date.now() - start < 400) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(waitingHeadersClosedAt).toBeGreaterThan(0);
    expect(waitingHeadersClosedAt - start).toBeLessThan(350);
  });

  it('phase 4: client aborts while streaming body and origin connection closes within ~300ms', async () => {
    streamingBodyClosedAt = 0;

    const cancelledPromise = new Promise<CancelledEvent>((resolve) => {
      const listener = (event: CancelledEvent) => {
        if (event.phase === 'streaming_body') {
          cancellationEvents.removeListener('request_cancelled', listener);
          resolve(event);
        }
      };
      cancellationEvents.on('request_cancelled', listener);
    });

    const clientSocket = net.connect(proxyPort, '127.0.0.1', () => {
      clientSocket.write(
        'GET /stream-body HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          '\r\n'
      );
    });
    clientSocket.on('error', () => {});

    clientSocket.once('data', () => {
      // Received first chunk from stream, now abort!
      clientSocket.destroy();
    });

    const event = await cancelledPromise;
    expect(event.phase).toBe('streaming_body');

    const start = Date.now();
    while (streamingBodyClosedAt === 0 && Date.now() - start < 400) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(streamingBodyClosedAt).toBeGreaterThan(0);
    expect(streamingBodyClosedAt - start).toBeLessThan(350);
  });

  it('after 200 repeated aborts, socket count and connection count return to baseline without leaks or warnings', async () => {
    const warnings: any[] = [];
    const warningHandler = (warning: any) => {
      warnings.push(warning);
    };
    process.on('warning', warningHandler);

    try {
      for (let i = 0; i < 200; i++) {
        await new Promise<void>((resolve) => {
          const sock = net.connect(proxyPort, '127.0.0.1', () => {
            sock.write(
              'GET /wait-headers HTTP/1.1\r\n' +
                `Host: 127.0.0.1:${proxyPort}\r\n` +
                '\r\n'
            );
            // Abort between 0 and 15ms
            setTimeout(() => {
              sock.destroy();
              resolve();
            }, Math.floor(Math.random() * 15));
          });
          sock.on('error', () => {
            resolve();
          });
        });
      }

      // Wait up to 1000ms for in flight count to return to 0
      const start = Date.now();
      while (proxyListener.inFlightCount > 0 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 30));
      }

      // Assert no MaxListenersExceeded warnings
      const maxListenersWarnings = warnings.filter((w) =>
        w.name?.includes('MaxListenersExceeded')
      );
      expect(maxListenersWarnings).toHaveLength(0);

      // Verify in flight requests count returned to 0
      expect(proxyListener.inFlightCount).toBe(0);

      // Verify upstream active sockets
      const httpAgent = (upstreamClient as any).httpAgent as http.Agent;
      const activeSockets = Object.values(httpAgent.sockets).flat().length;
      expect(activeSockets).toBe(0);
    } finally {
      process.removeListener('warning', warningHandler);
    }
  }, 15_000);

  it('aborting during a large upload stops reading the client body', async () => {
    uploadBytesReceived = 0;
    uploadClosedAt = 0;

    const chunk = Buffer.alloc(32 * 1024, 'x'); // 32 KB chunk

    const cancelledPromise = new Promise<CancelledEvent>((resolve) => {
      const listener = (event: CancelledEvent) => {
        if (event.phase === 'upload') {
          cancellationEvents.removeListener('request_cancelled', listener);
          resolve(event);
        }
      };
      cancellationEvents.on('request_cancelled', listener);
    });

    const clientSocket = net.connect(proxyPort, '127.0.0.1', () => {
      clientSocket.write(
        'POST /upload-slow HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          'Content-Length: 10485760\r\n' + // 10 MB declared
          '\r\n'
      );

      // Send 2 chunks (64 KB) and then abruptly destroy
      clientSocket.write(chunk);
      clientSocket.write(chunk);

      setTimeout(() => {
        clientSocket.destroy();
      }, 30);
    });
    clientSocket.on('error', () => {});

    await cancelledPromise;

    // Wait up to 500ms for uploadClosedAt to be observed
    const start = Date.now();
    while (uploadClosedAt === 0 && Date.now() - start < 500) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The upload must have stopped reading and never reached the declared 10 MB
    expect(uploadBytesReceived).toBeLessThan(1024 * 1024); // well below 1 MB
    expect(uploadClosedAt).toBeGreaterThan(0);
  });

  it('server shutdown past grace period aborts registered RequestContext with server_shutdown_past_grace_period', async () => {
    const tempListener = new ProxyListener(
      {
        listeners: { http: { host: '127.0.0.1', port: 0 } },
        shutdownGracePeriodMs: 100, // tiny grace period
        handleSignals: false,
      },
      () => {
        // no-op
      }
    );
    await tempListener.start();

    const ctx = createRequestContext();
    tempListener.registerContext(ctx);

    const abortPromise = new Promise<string>((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        resolve((ctx.signal as any).reason);
      });
    });

    // Stop server; activeContext is registered so drain waits until graceMs expires and aborts
    const stopPromise = tempListener.stop();

    const reason = await abortPromise;
    expect(reason).toBe('server_shutdown_past_grace_period');
    expect(ctx.signal.aborted).toBe(true);

    await stopPromise;
  });
});
