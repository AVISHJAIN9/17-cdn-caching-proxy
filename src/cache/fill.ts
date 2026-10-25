import { Transform, TransformCallback } from 'node:stream';
import http from 'node:http';
import { CacheStore, CacheEntry } from './store.js';
import { Clock } from '../util/clock.js';
import {
  checkResponseStorableFromHeaders,
  filterStoredHeaders,
  StorabilityReason,
  StorableMetadata,
} from './policy.js';
import { LifetimeConfig } from './lifetime.js';

export interface CacheFillOptions {
  keyHash: string;
  keyString: string;
  originId: string;
  namespace?: string;
  statusCode: number;
  statusMessage?: string;
  originHeaders: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
  requestTimeMs: number;
  responseTimeMs: number;
  config?: LifetimeConfig;
  store: CacheStore;
  clock: Clock;
  maxObjectBytes?: number;
  requestId?: string;
  hasAuthorization?: boolean;
  onStored?: (entry: CacheEntry) => void;
  onSkipped?: (reason: StorabilityReason | string) => void;
}

/**
 * CacheTeeStream intercepts body chunks between originRes and clientRes.
 * - Streams chunks to client with backpressure (never waits for whole body).
 * - Buffers chunks into bounded memory if response is storable.
 * - If buffered size exceeds maxObjectBytes: drops buffer immediately, logs cache_skip,
 *   and keeps streaming untouched to client.
 * - On clean completion with valid body size and no client abort: stores entry into store.
 */
export class CacheTeeStream extends Transform {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private isBuffering: boolean;
  private tooLarge = false;
  private aborted = false;
  private readonly maxObjectBytes: number;
  private readonly expectedContentLength?: number;
  private metadata?: StorableMetadata;

  constructor(private readonly options: CacheFillOptions) {
    super();
    this.maxObjectBytes =
      options.maxObjectBytes ?? options.store.maxObjectBytes ?? 5 * 1024 * 1024;

    const rawCl = options.originHeaders['content-length'];
    if (typeof rawCl === 'string' && /^\d+$/.test(rawCl.trim())) {
      this.expectedContentLength = parseInt(rawCl.trim(), 10);
    }

    // Check if initial headers qualify for storage
    const headerCheck = checkResponseStorableFromHeaders({
      statusCode: options.statusCode,
      headers: options.originHeaders,
      rawHeaders: options.rawHeaders,
      requestTimeMs: options.requestTimeMs,
      responseTimeMs: options.responseTimeMs,
      config: options.config,
      requestId: options.requestId,
      hasAuthorization: options.hasAuthorization,
    });

    if (!headerCheck.storable) {
      this.isBuffering = false;
      this.options.onSkipped?.(headerCheck.reason!);
    } else if (
      this.expectedContentLength !== undefined &&
      this.expectedContentLength > this.maxObjectBytes
    ) {
      this.isBuffering = false;
      this.tooLarge = true;
      console.warn(
        `cache_skip: content-length (${this.expectedContentLength}) exceeds maxObjectBytes (${this.maxObjectBytes})`
      );
      this.options.onSkipped?.('too_large');
    } else {
      this.isBuffering = true;
      this.metadata = headerCheck.metadata;
    }
  }

  public isStorable(): boolean {
    return this.isBuffering;
  }

  _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

    if (this.isBuffering && !this.tooLarge && !this.aborted) {
      this.totalBytes += buf.length;
      if (this.totalBytes > this.maxObjectBytes) {
        this.tooLarge = true;
        this.isBuffering = false;
        this.chunks = []; // Release buffered memory immediately so memory stays bounded
        console.warn(
          `cache_skip: body size (${this.totalBytes}) exceeded maxObjectBytes (${this.maxObjectBytes}) requestId=${this.options.requestId ?? 'unknown'}`
        );
        this.options.onSkipped?.('too_large');
      } else {
        this.chunks.push(buf);
      }
    }

    callback(null, buf);
  }

  abort(): void {
    this.aborted = true;
    this.isBuffering = false;
    this.chunks = [];
  }

  /**
   * Called when origin stream ends cleanly.
   * clientAborted indicates whether client disconnected before origin finished.
   */
  finish(clientAborted: boolean = false): boolean {
    if (this.aborted || this.tooLarge || !this.isBuffering || !this.metadata) {
      this.chunks = [];
      return false;
    }

    if (clientAborted) {
      this.options.onSkipped?.('client_aborted');
      this.chunks = [];
      return false;
    }

    if (this.expectedContentLength !== undefined && this.totalBytes !== this.expectedContentLength) {
      this.options.onSkipped?.('body_incomplete');
      this.chunks = [];
      return false;
    }

    const body = Buffer.concat(this.chunks, this.totalBytes);
    this.chunks = []; // Release references

    const storedHeaders = filterStoredHeaders(
      this.options.originHeaders,
      body.length,
      this.metadata.resolvedDateHeader
    );
    const now = this.options.clock.now();

    const entry: CacheEntry = {
      keyHash: this.options.keyHash,
      keyString: this.options.keyString,
      originId: this.options.originId,
      namespace: this.options.namespace ?? 'default',
      status: this.options.statusCode,
      statusMessage:
        this.options.statusMessage ?? http.STATUS_CODES[this.options.statusCode] ?? 'OK',
      headers: storedHeaders,
      body,
      size: body.length,
      storedAt: now,
      hitCount: 0,
      lastAccessedAt: now,
      requestTimeMs: this.metadata.requestTimeMs,
      responseTimeMs: this.metadata.responseTimeMs,
      dateValueMs: this.metadata.dateValueMs,
      ageValueSeconds: this.metadata.ageValueSeconds,
      freshnessLifetimeMs: this.metadata.freshnessLifetimeMs,
      lifetimeSource: this.metadata.lifetimeSource,
      dateSource: this.metadata.dateSource,
      etag: this.metadata.etag,
      etagRaw: this.metadata.etagRaw,
      lastModifiedMs: this.metadata.lastModifiedMs,
      lastModifiedRaw: this.metadata.lastModifiedRaw,
    };

    const stored = this.options.store.set(entry);
    if (stored) {
      this.options.onStored?.(entry);
      return true;
    } else {
      this.options.onSkipped?.('cache_full');
      return false;
    }
  }
}
