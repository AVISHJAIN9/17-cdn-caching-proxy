/**
 * Synchronous Revalidation Engine per RFC 9111.
 */

import http from 'node:http';
import { CacheEntry, CacheStore } from './store.js';
import { Clock } from '../util/clock.js';
import { RequestContext } from '../proxy/context.js';
import { CacheConfig } from '../proxy/index.js';
import { CacheKey } from './key.js';
import { applyNotModified } from './refresh.js';
import { evaluateClientConditionals } from './preconditions.js';
import { serveCacheHit, serveCache304, serveCacheStale } from './serve.js';
import { isWithinStaleIfError } from './stale.js';
import { parseCacheControl } from './cache-control.js';
import { CacheTeeStream } from './fill.js';
import { ProxyError } from '../proxy/errors.js';
import { sendError } from '../proxy/error-response.js';
import { UpstreamClient } from '../proxy/upstream.js';
import { buildUpstreamConditionals } from './upstream-conditionals.js';
import { checkResponseStorableFromHeaders, filterStoredHeaders } from './policy.js';


export interface HandleRevalidationResponseOptions {
  staleEntry: CacheEntry;
  expectedVersion?: number;
  cacheKey: CacheKey;
  originRes: http.IncomingMessage;
  clientRes: http.ServerResponse;
  clientReq: http.IncomingMessage;
  proxyReq: any;
  ctx: RequestContext;
  store: CacheStore;
  clock: Clock;
  cacheConfig: CacheConfig;
  requestTimeMs: number;
  responseTimeMs: number;
  extraHeaders: Record<string, string | string[]>;
  streamOriginResponse: (
    originRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
    method: string,
    options: any
  ) => Promise<void>;
  coordinator: any;
  unregister: () => void;
}

/**
 * Handles the upstream response during synchronous cache revalidation:
 *
 * a. Origin 304:
 *    - applyNotModified:
 *      - "refreshed": replaces entry (if version matches, else logs revalidation_superseded and keeps newer),
 *        evaluates client conditionals against refreshed entry, serves 304 or 200 with X-Cache: REVALIDATED.
 *      - "mismatch": deletes entry, logs validator_mismatch, responds 502 UPSTREAM_INVALID_RESPONSE.
 *      - "not_storable_anymore": serves once, deletes entry.
 * b. Origin 200:
 *    - Treats as normal MISS fill (streams to client, tees to store).
 *    - Replaces stale entry when stored; deletes stale entry when not storable.
 *    - Debug headers: X-Cache: MISS, X-Cache-Reason: revalidated_replaced.
 * c. Origin 404 or 410:
 *    - Passes through, deletes stale entry.
 * d. Other 3xx/4xx:
 *    - Passes through, keeps stale entry untouched, stores nothing.
 * e. Origin 5xx:
 *    - Passes 5xx through unchanged, keeps stale entry untouched, never serves it.
 */
export async function handleRevalidationResponse(
  options: HandleRevalidationResponseOptions
): Promise<void> {
  const {
    staleEntry,
    expectedVersion,
    cacheKey,
    originRes,
    clientRes,
    clientReq,
    proxyReq,
    ctx,
    store,
    clock,
    cacheConfig,
    requestTimeMs,
    responseTimeMs,
    extraHeaders,
    streamOriginResponse,
    coordinator,
    unregister,
  } = options;

  const statusCode = originRes.statusCode ?? 200;

  // a. Origin 304 Not Modified
  if (statusCode === 304) {
    const refreshResult = applyNotModified(
      staleEntry,
      {
        headers: originRes.headers,
        rawHeaders: originRes.rawHeaders,
      },
      {
        requestTimeMs,
        responseTimeMs,
        config: {
          maxTtlMs: cacheConfig.maxTtlMs,
          minTtlMs: cacheConfig.minTtlMs,
          heuristic: cacheConfig.heuristic,
        },
        requestId: ctx.requestId,
      }
    );

    if (refreshResult.kind === 'mismatch') {
      store.recordRevalidation?.('mismatch');
      store.delete(staleEntry.keyHash);
      console.warn(`validator_mismatch requestId=${ctx.requestId}`);
      console.log(
        JSON.stringify({
          event: 'revalidate_result',
          requestId: ctx.requestId,
          status: 304,
          outcome: 'mismatch',
        })
      );
      sendError(
        ctx,
        clientRes,
        new ProxyError(
          'UPSTREAM_INVALID_RESPONSE',
          502,
          'Validator mismatch on 304 response from origin',
          { retryable: false }
        )
      );
      unregister();
      return;
    }

    if (refreshResult.kind === 'not_storable_anymore') {
      store.recordRevalidation?.('not_modified');
      store.delete(staleEntry.keyHash);
      console.log(
        JSON.stringify({
          event: 'revalidate_result',
          requestId: ctx.requestId,
          status: 304,
          outcome: 'not_storable_anymore',
        })
      );

      // Evaluate client conditionals against the refreshed entry
      const condResult = evaluateClientConditionals(
        {
          method: proxyReq.method,
          ifNoneMatch: proxyReq.headers['if-none-match'],
          ifModifiedSince: proxyReq.headers['if-modified-since'],
        },
        {
          etag: refreshResult.entry.etag,
          lastModifiedMs: refreshResult.entry.lastModifiedMs,
        }
      );

      const revalHeaders: Record<string, string | string[]> = {};
      if (cacheConfig.debugHeaders) {
        revalHeaders['x-cache'] = 'REVALIDATED';
      }

      if (condResult.outcome === 'not_modified') {
        serveCache304({
          entry: refreshResult.entry,
          clientRes,
          clientReq,
          debugHeaders: cacheConfig.debugHeaders ?? true,
          extraHeaders: revalHeaders,
          requestId: ctx.requestId,
          context: ctx,
          clock,
        });
      } else {
        await serveCacheHit({
          entry: refreshResult.entry,
          clientRes,
          clientReq,
          debugHeaders: cacheConfig.debugHeaders ?? true,
          extraHeaders: revalHeaders,
          requestId: ctx.requestId,
          context: ctx,
          clock,
        });
      }
      unregister();
      return;
    }

    if (refreshResult.kind === 'refreshed') {
      const currentInStore = store.get(staleEntry.keyHash);
      let entryToServe = refreshResult.entry;

      if (currentInStore && currentInStore.version !== expectedVersion) {
        // Entry changed underneath us during concurrent revalidation
        store.recordRevalidation?.('superseded');
        console.warn(`revalidation_superseded requestId=${ctx.requestId}`);
        console.log(
          JSON.stringify({
            event: 'revalidate_result',
            requestId: ctx.requestId,
            status: 304,
            outcome: 'superseded',
          })
        );
        entryToServe = currentInStore;
      } else {
        store.set(refreshResult.entry);
        store.recordRevalidation?.('not_modified');
        console.log(
          JSON.stringify({
            event: 'revalidate_result',
            requestId: ctx.requestId,
            status: 304,
            outcome: 'refreshed',
          })
        );
      }

      // Evaluate client conditionals against entryToServe
      const condResult = evaluateClientConditionals(
        {
          method: proxyReq.method,
          ifNoneMatch: proxyReq.headers['if-none-match'],
          ifModifiedSince: proxyReq.headers['if-modified-since'],
        },
        {
          etag: entryToServe.etag,
          lastModifiedMs: entryToServe.lastModifiedMs,
        }
      );

      const revalHeaders: Record<string, string | string[]> = {};
      if (cacheConfig.debugHeaders) {
        revalHeaders['x-cache'] = 'REVALIDATED';
      }

      if (condResult.outcome === 'not_modified') {
        (store as any).recordNotModified?.();
        serveCache304({
          entry: entryToServe,
          clientRes,
          clientReq,
          debugHeaders: cacheConfig.debugHeaders ?? true,
          extraHeaders: revalHeaders,
          requestId: ctx.requestId,
          context: ctx,
          clock,
        });
      } else {
        await serveCacheHit({
          entry: entryToServe,
          clientRes,
          clientReq,
          debugHeaders: cacheConfig.debugHeaders ?? true,
          extraHeaders: revalHeaders,
          requestId: ctx.requestId,
          context: ctx,
          clock,
        });
      }
      unregister();
      return;
    }
  }

  // b. Origin 200 OK: normal MISS fill
  if (statusCode === 200) {
    if (cacheConfig.debugHeaders) {
      extraHeaders['x-cache'] = 'MISS';
      extraHeaders['x-cache-reason'] = 'revalidated_replaced';
    }

    const teeStream = new CacheTeeStream({
      keyHash: cacheKey.keyHash,
      keyString: cacheKey.keyString,
      originId: 'default',
      statusCode: originRes.statusCode ?? 200,
      statusMessage: originRes.statusMessage,
      originHeaders: originRes.headers,
      rawHeaders: originRes.rawHeaders,
      requestTimeMs,
      responseTimeMs,
      config: {
        maxTtlMs: cacheConfig.maxTtlMs,
        minTtlMs: cacheConfig.minTtlMs,
        heuristic: cacheConfig.heuristic,
      },
      store,
      clock,
      maxObjectBytes: store.maxObjectBytes ?? cacheConfig.maxObjectBytes,
      requestId: ctx.requestId,
      onStored: () => {
        store.recordRevalidation?.('replaced');
        console.log(
          JSON.stringify({
            event: 'revalidate_result',
            requestId: ctx.requestId,
            status: 200,
            outcome: 'replaced',
          })
        );
      },
      onSkipped: (reason) => {
        store.recordRevalidation?.('replaced');
        store.delete(staleEntry.keyHash); // superseded entry must be deleted if 200 is not storable
        console.warn(`cache_skip reason=${reason} requestId=${ctx.requestId}`);
        if (cacheConfig.debugHeaders) {
          extraHeaders['x-cache-reason'] = reason;
        }
        console.log(
          JSON.stringify({
            event: 'revalidate_result',
            requestId: ctx.requestId,
            status: 200,
            outcome: 'not_storable_superseded',
          })
        );
      },
    });

    await streamOriginResponse(originRes, clientRes, proxyReq.method, {
      requestId: ctx.requestId,
      context: ctx,
      teeStream,
      extraHeaders,
      clock,
      responseTimeMs,
      onUpstreamAbortedMidbody: () => {
        coordinator.setPhase('aborted');
      },
    }).catch(() => {});
    return;
  }

  // c. Origin 404 or 410: delete stale entry, pass through
  if (statusCode === 404 || statusCode === 410) {
    store.recordRevalidation?.('failed');
    store.delete(staleEntry.keyHash);
    console.log(
      JSON.stringify({
        event: 'revalidate_result',
        requestId: ctx.requestId,
        status: statusCode,
        outcome: 'deleted',
      })
    );

    void streamOriginResponse(originRes, clientRes, proxyReq.method, {
      requestId: ctx.requestId,
      context: ctx,
      extraHeaders,
      clock,
      responseTimeMs,
      onUpstreamAbortedMidbody: () => {
        coordinator.setPhase('aborted');
      },
    }).catch(() => {});
    return;
  }

  // d. Other 3xx/4xx: keep stale entry untouched, pass through
  // e. Origin 5xx: if within stale-if-error, serve stale with Warning 110; else pass 5xx through
  if (statusCode >= 500) {
    const clientReqCc = parseCacheControl(clientReq?.headers['cache-control']);
    if (isWithinStaleIfError(staleEntry, clock.now(), clientReqCc.staleIfError)) {
      store.recordRevalidation?.('failed');
      originRes.resume();
      await serveCacheStale({
        entry: staleEntry,
        clientRes,
        clientReq,
        debugHeaders: cacheConfig.debugHeaders ?? true,
        requestId: ctx.requestId,
        context: ctx,
        clock,
        reason: 'stale_if_error',
        warning: '110 - "Response is Stale"',
      });
      unregister();
      return;
    }
  }

  store.recordRevalidation?.('failed');
  console.log(
    JSON.stringify({
      event: 'revalidate_result',
      requestId: ctx.requestId,
      status: statusCode,
      outcome: statusCode >= 500 ? 'origin_5xx' : 'origin_other',
    })
  );


  void streamOriginResponse(originRes, clientRes, proxyReq.method, {
    requestId: ctx.requestId,
    context: ctx,
    extraHeaders,
    clock,
    responseTimeMs,
    onUpstreamAbortedMidbody: () => {
      coordinator.setPhase('aborted');
    },
  }).catch(() => {});
}

export interface BackgroundRevalidationOptions {
  cacheKey: CacheKey;
  staleEntry: CacheEntry;
  targetUrl: URL;
  headersToSend: Record<string, string | string[]>;
  upstreamClient: UpstreamClient;
  store: CacheStore;
  clock: Clock;
  cacheConfig: CacheConfig;
  inflightSet: Set<string>;
  requestId?: string;
}

/**
 * Triggers an asynchronous revalidation request to the origin in the background per RFC 5861.
 * Exactly one background revalidation executes per keyHash at any given time.
 */
export function triggerBackgroundRevalidation(options: BackgroundRevalidationOptions): void {
  const {
    cacheKey,
    staleEntry,
    targetUrl,
    headersToSend,
    upstreamClient,
    store,
    clock,
    cacheConfig,
    inflightSet,
    requestId = 'bg-reval',
  } = options;

  if (inflightSet.has(cacheKey.keyHash)) {
    return;
  }
  inflightSet.add(cacheKey.keyHash);

  const requestHeaders: Record<string, string | string[]> = { ...headersToSend };
  delete requestHeaders['if-none-match'];
  delete requestHeaders['if-modified-since'];

  const conditionals = buildUpstreamConditionals(staleEntry);
  if (conditionals.ifNoneMatch) {
    requestHeaders['if-none-match'] = conditionals.ifNoneMatch;
  }
  if (conditionals.ifModifiedSince) {
    requestHeaders['if-modified-since'] = conditionals.ifModifiedSince;
  }

  const requestTimeMs = clock.now();

  try {
    const upstreamReq = upstreamClient.request(
      {
        url: targetUrl,
        method: 'GET',
        headers: requestHeaders as http.OutgoingHttpHeaders,
      },
      (originRes) => {
        const responseTimeMs = clock.now();
        const statusCode = originRes.statusCode ?? 200;

        if (statusCode === 304) {
          try {
            const refreshResult = applyNotModified(
              staleEntry,
              {
                headers: originRes.headers,
                rawHeaders: originRes.rawHeaders,
              },
              {
                requestTimeMs,
                responseTimeMs,
                config: {
                  maxTtlMs: cacheConfig.maxTtlMs,
                  minTtlMs: cacheConfig.minTtlMs,
                  heuristic: cacheConfig.heuristic,
                },
                requestId,
              }
            );

            if (refreshResult.kind === 'mismatch' || refreshResult.kind === 'not_storable_anymore') {
              store.delete(staleEntry.keyHash);
            } else if (refreshResult.kind === 'refreshed') {
              store.set(refreshResult.entry);
            }
          } catch {
            // ignore
          } finally {
            originRes.resume();
            inflightSet.delete(cacheKey.keyHash);
          }
          return;
        }

        if (statusCode === 200) {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          const maxBytes = store.maxObjectBytes ?? cacheConfig.maxObjectBytes ?? 5 * 1024 * 1024;
          let tooLarge = false;

          originRes.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              tooLarge = true;
              chunks.length = 0;
              return;
            }
            chunks.push(chunk);
          });

          originRes.on('end', () => {
            try {
              if (!tooLarge) {
                const body = Buffer.concat(chunks, totalBytes);
                const check = checkResponseStorableFromHeaders({
                  statusCode: 200,
                  headers: originRes.headers,
                  rawHeaders: originRes.rawHeaders,
                  requestTimeMs,
                  responseTimeMs,
                  config: {
                    maxTtlMs: cacheConfig.maxTtlMs,
                    minTtlMs: cacheConfig.minTtlMs,
                    heuristic: cacheConfig.heuristic,
                  },
                  requestId,
                });

                if (check.storable && check.metadata) {
                  const storedHeaders = filterStoredHeaders(
                    originRes.headers,
                    body.length,
                    check.metadata.resolvedDateHeader
                  );
                  const now = clock.now();
                  const newEntry: CacheEntry = {
                    keyHash: cacheKey.keyHash,
                    keyString: cacheKey.keyString,
                    originId: 'default',
                    status: 200,
                    statusMessage: originRes.statusMessage ?? 'OK',
                    headers: storedHeaders,
                    body,
                    size: body.length,
                    storedAt: now,
                    hitCount: 0,
                    lastAccessedAt: now,
                    requestTimeMs: check.metadata.requestTimeMs,
                    responseTimeMs: check.metadata.responseTimeMs,
                    dateValueMs: check.metadata.dateValueMs,
                    ageValueSeconds: check.metadata.ageValueSeconds,
                    freshnessLifetimeMs: check.metadata.freshnessLifetimeMs,
                    lifetimeSource: check.metadata.lifetimeSource,
                    dateSource: check.metadata.dateSource,
                    etag: check.metadata.etag,
                    etagRaw: check.metadata.etagRaw,
                    lastModifiedMs: check.metadata.lastModifiedMs,
                    lastModifiedRaw: check.metadata.lastModifiedRaw,
                    version: (staleEntry.version ?? 0) + 1,
                  };
                  store.set(newEntry);
                }
              }
            } catch {
              // ignore
            } finally {
              inflightSet.delete(cacheKey.keyHash);
            }
          });

          originRes.on('error', () => {
            inflightSet.delete(cacheKey.keyHash);
          });
          return;
        }

        if (statusCode === 404 || statusCode === 410) {
          store.delete(staleEntry.keyHash);
        }

        originRes.resume();
        inflightSet.delete(cacheKey.keyHash);
      },
      () => {
        inflightSet.delete(cacheKey.keyHash);
      }
    );

    upstreamReq.on('error', () => {
      inflightSet.delete(cacheKey.keyHash);
    });
  } catch {
    inflightSet.delete(cacheKey.keyHash);
  }
}

