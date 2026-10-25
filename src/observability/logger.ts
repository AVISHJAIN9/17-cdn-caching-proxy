import { Writable } from 'node:stream';

export interface RequestLogRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  cache: 'HIT' | 'MISS' | 'BYPASS' | 'STALE' | string;
  bytesSent: number;
  tenant?: string;
  error?: string;
  clientIp?: string;
  userAgent?: string;
}

export interface RequestLoggerOptions {
  outputStream?: Writable | ((line: string) => void);
  maxQueueSize?: number; // default: 10,000
  sampleRate?: number; // 0.0 to 1.0 (default 1.0 = 100%)
  clock?: { now: () => number };
}

const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'client_secret',
  'password',
  'auth',
  'authorization',
  'sig',
  'signature',
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

/**
 * Redacts sensitive values from headers
 */
export function redactHeader(name: string, value: string | string[]): string | string[] {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADERS.has(lower)) {
    return Array.isArray(value) ? value.map(() => '[REDACTED]') : '[REDACTED]';
  }
  return value;
}

/**
 * Redacts sensitive query parameters from a raw URL or path
 */
export function redactUrlPath(rawUrl: string): string {
  if (!rawUrl) return '/';

  try {
    const qIndex = rawUrl.indexOf('?');
    if (qIndex === -1) {
      return rawUrl;
    }

    const pathPart = rawUrl.slice(0, qIndex);
    const queryString = rawUrl.slice(qIndex + 1);
    if (!queryString) {
      return pathPart;
    }

    const searchParams = new URLSearchParams(queryString);
    for (const key of Array.from(searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        SENSITIVE_QUERY_PARAMS.has(lower) ||
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('password') ||
        lower.includes('auth')
      ) {
        searchParams.set(key, '[REDACTED]');
      }
    }

    const newQuery = searchParams.toString();
    return newQuery ? `${pathPart}?${newQuery}` : pathPart;
  } catch {
    return rawUrl;
  }
}

/**
 * Non-blocking, flood-bounded Request Logger emitting structured JSON lines.
 */
export class RequestLogger {
  private readonly outputStream?: Writable | ((line: string) => void);
  private readonly maxQueueSize: number;
  private readonly sampleRate: number;
  private queue: string[] = [];
  private isFlushing = false;
  private droppedCount = 0;
  private recordedLogs: RequestLogRecord[] = []; // In-memory buffer for testing inspection

  constructor(options: RequestLoggerOptions = {}) {
    this.outputStream = options.outputStream;
    this.maxQueueSize = options.maxQueueSize ?? 10000;
    this.sampleRate = options.sampleRate ?? 1.0;
  }

  /**
   * Logs a request completion record safely and non-blockingly.
   */
  public log(record: RequestLogRecord): void {
    try {
      // Sampling check
      if (this.sampleRate < 1.0 && Math.random() >= this.sampleRate) {
        return;
      }

      // Keep recent logs in memory for inspection/tests (bounded to 1000)
      if (this.recordedLogs.length >= 1000) {
        this.recordedLogs.shift();
      }
      this.recordedLogs.push({ ...record });

      // Format to single JSON line
      const jsonLine = JSON.stringify(record) + '\n';

      // Check flood bounds
      if (this.queue.length >= this.maxQueueSize) {
        this.droppedCount++;
        return; // Non-blocking drop policy under severe flood
      }

      this.queue.push(jsonLine);
      this.scheduleFlush();
    } catch {
      // Logging must never crash the request path
    }
  }

  private scheduleFlush(): void {
    if (this.isFlushing) return;
    this.isFlushing = true;

    setImmediate(() => {
      this.flushQueue();
    });
  }

  private flushQueue(): void {
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;

        if (typeof this.outputStream === 'function') {
          this.outputStream(item);
        } else if (this.outputStream && 'write' in this.outputStream) {
          const canWriteMore = this.outputStream.write(item);
          if (!canWriteMore) {
            this.outputStream.once('drain', () => {
              this.flushQueue();
            });
            return;
          }
        }
      }
    } catch {
      // Safely ignore output stream write failures
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  public getRecordedLogs(): readonly RequestLogRecord[] {
    return [...this.recordedLogs];
  }

  public getDroppedCount(): number {
    return this.droppedCount;
  }

  public clear(): void {
    this.queue = [];
    this.recordedLogs = [];
    this.droppedCount = 0;
  }
}
