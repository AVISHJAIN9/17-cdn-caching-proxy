/**
 * Background Revalidation Job Runner per RFC 5861 / RFC 9111.
 * Reuses Batch 7 conditional-request logic and 304 header merge engine.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { CacheEntry, CacheStore } from './store.js';
import { Clock } from '../util/clock.js';
import { CacheConfig } from '../proxy/index.js';
import { applyNotModified } from './refresh.js';
import { formatHttpDate } from './http-date.js';
import { parseEntityTag } from './etag.js';
import {
  checkResponseStorableFromHeaders,
  filterStoredHeaders,
} from './policy.js';

import { RevalidationLockManager, LockHandle } from './locks.js';

export interface BackgroundRevalidatorOptions {
  store: CacheStore;
  clock: Clock;
  cacheConfig: CacheConfig;
  lockManager?: RevalidationLockManager;
}

export interface BackgroundJobOptions {
  staleEntry: CacheEntry;
  originUrl: string;
  requestId?: string;
  timeoutMs?: number;
  headers?: Record<string, string | string[]>;
}

export interface BackgroundJobResult {
  status?: number;
  outcome: 'refreshed' | 'replaced' | 'deleted' | 'preserved' | 'error' | 'mismatch';
  error?: Error;
}

export class BackgroundRevalidator {
  private store: CacheStore;
  private clock: Clock;
  private cacheConfig: CacheConfig;
  private lockManager?: RevalidationLockManager;
  private activeJobs = new Map<string, Promise<BackgroundJobResult>>();

  constructor(options: BackgroundRevalidatorOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.cacheConfig = options.cacheConfig;
    this.lockManager = options.lockManager;
  }

  get activeJobsCount(): number {
    return this.activeJobs.size;
  }

  hasActiveJob(keyHash: string): boolean {
    return this.activeJobs.has(keyHash);
  }

  getActiveJob(keyHash: string): Promise<BackgroundJobResult> | undefined {
    return this.activeJobs.get(keyHash);
  }

  /**
   * Triggers an asynchronous background revalidation job for a stale cache entry.
   */
  revalidateInBackground(options: BackgroundJobOptions): Promise<BackgroundJobResult> {
    const keyHash = options.staleEntry.keyHash;
    const existing = this.activeJobs.get(keyHash);
    if (existing) {
      return existing;
    }

    let lockHandle: LockHandle | null = null;
    if (this.lockManager) {
      lockHandle = this.lockManager.tryAcquire(keyHash, { timeoutMs: options.timeoutMs });
      if (!lockHandle) {
        return Promise.resolve({ outcome: 'preserved' });
      }
    }

    const jobPromise = this.executeRevalidation(options).finally(() => {
      this.activeJobs.delete(keyHash);
      if (lockHandle) {
        lockHandle.release();
      }
    });

    this.activeJobs.set(keyHash, jobPromise);
    return jobPromise;
  }

  private async executeRevalidation(options: BackgroundJobOptions): Promise<BackgroundJobResult> {
    const { staleEntry, originUrl, requestId, timeoutMs = 10000, headers: extraHeaders = {} } = options;
    const targetUrl = new URL(originUrl);
    const transport = targetUrl.protocol === 'https:' ? https : http;

    const requestHeaders: Record<string, string> = {
      'host': targetUrl.host,
      'accept': '*/*',
      'user-agent': 'CDN-Proxy-Background-Revalidation/1.0',
    };

    // Forward any extra headers
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (typeof v === 'string') {
        requestHeaders[k.toLowerCase()] = v;
      }
    }

    // Attach conditional headers from stale entry
    if (staleEntry.etagRaw) {
      requestHeaders['if-none-match'] = staleEntry.etagRaw;
    }
    if (staleEntry.lastModifiedRaw) {
      requestHeaders['if-modified-since'] = staleEntry.lastModifiedRaw;
    }

    const requestTimeMs = this.clock.now();

    return new Promise<BackgroundJobResult>((resolve) => {
      const req = transport.request(
        targetUrl,
        {
          method: 'GET',
          headers: requestHeaders,
          timeout: timeoutMs,
        },
        async (res) => {
          const responseTimeMs = this.clock.now();
          const statusCode = res.statusCode ?? 200;

          // 1. Upstream 304 Not Modified
          if (statusCode === 304) {
            try {
              const refreshResult = applyNotModified(
                staleEntry,
                {
                  headers: res.headers,
                  rawHeaders: res.rawHeaders,
                },
                {
                  requestTimeMs,
                  responseTimeMs,
                  config: {
                    maxTtlMs: this.cacheConfig.maxTtlMs,
                    minTtlMs: this.cacheConfig.minTtlMs,
                    heuristic: this.cacheConfig.heuristic,
                  },
                  requestId,
                }
              );

              if (refreshResult.kind === 'refreshed') {
                this.store.set(refreshResult.entry);
                this.store.recordRevalidation?.('not_modified');
                console.log(
                  JSON.stringify({
                    event: 'revalidate_result',
                    requestId,
                    status: 304,
                    outcome: 'refreshed',
                  })
                );
                resolve({ status: 304, outcome: 'refreshed' });
                return;
              }

              if (refreshResult.kind === 'mismatch') {
                this.store.delete(staleEntry.keyHash);
                this.store.recordRevalidation?.('mismatch');
                console.log(
                  JSON.stringify({
                    event: 'revalidate_result',
                    requestId,
                    status: 304,
                    outcome: 'mismatch',
                  })
                );
                resolve({ status: 304, outcome: 'mismatch' });
                return;
              }

              if (refreshResult.kind === 'not_storable_anymore') {
                this.store.delete(staleEntry.keyHash);
                resolve({ status: 304, outcome: 'deleted' });
                return;
              }
            } catch (err: any) {
              resolve({ status: 304, outcome: 'error', error: err });
              return;
            } finally {
              res.resume();
            }
          }

          // 2. Upstream 200 OK (Full Replacement)
          if (statusCode === 200) {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
              try {
                const body = Buffer.concat(chunks);
                const storableCheck = checkResponseStorableFromHeaders({
                  statusCode: 200,
                  headers: res.headers,
                  rawHeaders: res.rawHeaders,
                  requestTimeMs,
                  responseTimeMs,
                  config: {
                    maxTtlMs: this.cacheConfig.maxTtlMs,
                    minTtlMs: this.cacheConfig.minTtlMs,
                    heuristic: this.cacheConfig.heuristic,
                  },
                  requestId,
                });

                if (storableCheck.storable && storableCheck.metadata) {
                  const meta = storableCheck.metadata;
                  const storedHeaders = filterStoredHeaders(
                    res.headers,
                    body.length,
                    meta.resolvedDateHeader
                  );

                  const newEntry: CacheEntry = {
                    keyHash: staleEntry.keyHash,
                    keyString: staleEntry.keyString,
                    originId: staleEntry.originId,
                    status: 200,
                    statusMessage: 'OK',
                    headers: storedHeaders,
                    body,
                    size: body.length,
                    storedAt: responseTimeMs,
                    hitCount: 0,
                    lastAccessedAt: responseTimeMs,
                    requestTimeMs,
                    responseTimeMs,
                    dateValueMs: meta.dateValueMs,
                    ageValueSeconds: meta.ageValueSeconds,
                    freshnessLifetimeMs: meta.freshnessLifetimeMs,
                    lifetimeSource: meta.lifetimeSource,
                    etag: meta.etag,
                    etagRaw: meta.etagRaw,
                    lastModifiedMs: meta.lastModifiedMs,
                    lastModifiedRaw: meta.lastModifiedRaw,
                    version: (staleEntry.version ?? 1) + 1,
                  };
                  this.store.set(newEntry);
                  this.store.recordRevalidation?.('replaced');
                  console.log(
                    JSON.stringify({
                      event: 'revalidate_result',
                      requestId,
                      status: 200,
                      outcome: 'replaced',
                    })
                  );
                  resolve({ status: 200, outcome: 'replaced' });
                } else {
                  this.store.delete(staleEntry.keyHash);
                  resolve({ status: 200, outcome: 'deleted' });
                }
              } catch (err: any) {
                resolve({ status: 200, outcome: 'error', error: err });
              }
            });
            res.on('error', (err) => {
              resolve({ status: 200, outcome: 'error', error: err });
            });
            return;
          }

          // 3. Upstream 404 or 410 (Resource vanished)
          if (statusCode === 404 || statusCode === 410) {
            res.resume();
            this.store.delete(staleEntry.keyHash);
            resolve({ status: statusCode, outcome: 'deleted' });
            return;
          }

          // 4. Upstream 5xx or other status: preserve stale entry
          res.resume();
          resolve({ status: statusCode, outcome: 'preserved' });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Background revalidation upstream timeout'));
      });

      req.on('error', (err) => {
        resolve({ outcome: 'error', error: err });
      });

      req.end();
    });
  }
}
