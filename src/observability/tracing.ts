import crypto from 'node:crypto';
import http from 'node:http';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number; // 1 = sampled, 0 = not sampled
  tracestate?: string;
}

export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface Span {
  readonly name: string;
  readonly context: TraceContext;
  readonly parentId?: string;
  readonly startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(code: SpanStatusCode, message?: string): this;
  end(endTimeMs?: number): void;
}

export interface SpanExporter {
  export(spans: readonly Span[]): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

/**
 * In-Memory Exporter for testing assertions
 */
export class InMemorySpanExporter implements SpanExporter {
  private spans: Span[] = [];

  public export(spans: readonly Span[]): void {
    this.spans.push(...spans);
  }

  public getFinishedSpans(): readonly Span[] {
    return [...this.spans];
  }

  public clear(): void {
    this.spans = [];
  }
}

/**
 * Lightweight OTLP/HTTP JSON Exporter for local OpenTelemetry collectors
 */
export class OtlpHttpJsonSpanExporter implements SpanExporter {
  private readonly endpoint: string;

  constructor(endpoint = 'http://127.0.0.1:4318/v1/traces') {
    this.endpoint = endpoint;
  }

  public async export(spans: readonly Span[]): Promise<void> {
    if (spans.length === 0) return;

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'cdn-caching-proxy' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'cdn-caching-proxy' },
              spans: spans.map((s) => ({
                traceId: s.context.traceId,
                spanId: s.context.spanId,
                parentSpanId: s.parentId,
                name: s.name,
                startTimeUnixNano: String(s.startTimeMs * 1_000_000),
                endTimeUnixNano: String((s.endTimeMs ?? s.startTimeMs) * 1_000_000),
                status: {
                  code: s.status.code === 'ERROR' ? 2 : s.status.code === 'OK' ? 1 : 0,
                  message: s.status.message,
                },
                attributes: Object.entries(s.attributes).map(([k, v]) => ({
                  key: k,
                  value:
                    typeof v === 'boolean'
                      ? { boolValue: v }
                      : typeof v === 'number'
                      ? { doubleValue: v }
                      : { stringValue: String(v) },
                })),
              })),
            },
          ],
        },
      ],
    };

    try {
      const body = JSON.stringify(payload);
      const url = new URL(this.endpoint);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port || 4318,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 2000,
          },
          (res) => {
            res.resume();
            resolve();
          }
        );
        req.on('error', () => resolve()); // Non-blocking failure tolerance
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
        req.write(body);
        req.end();
      });
    } catch {
      // Exporter must never fail the proxy
    }
  }
}

/**
 * Validates and parses W3C traceparent header:
 * Format: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
export function parseTraceparent(rawHeader?: string): TraceContext | null {
  if (!rawHeader || typeof rawHeader !== 'string') {
    return null;
  }

  const trimmed = rawHeader.trim();
  const parts = trimmed.split('-');
  if (parts.length !== 4) {
    return null;
  }

  const [version, traceId, spanId, flags] = parts;
  if (version !== '00' || traceId.length !== 32 || spanId.length !== 16 || flags.length !== 2) {
    return null;
  }

  // Ensure valid hex
  if (!/^[0-9a-fA-F]{32}$/.test(traceId) || !/^[0-9a-fA-F]{16}$/.test(spanId) || !/^[0-9a-fA-F]{2}$/.test(flags)) {
    return null;
  }

  // Reject all zeros
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null;
  }

  const parsedFlags = parseInt(flags, 16);
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: Number.isNaN(parsedFlags) ? 1 : parsedFlags,
  };
}

/**
 * Formats a TraceContext to W3C traceparent header string
 */
export function formatTraceparent(context: TraceContext): string {
  const flagsHex = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flagsHex}`;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export class SpanImpl implements Span {
  public readonly name: string;
  public readonly context: TraceContext;
  public readonly parentId?: string;
  public readonly startTimeMs: number;
  public endTimeMs?: number;
  public durationMs?: number;
  public status: SpanStatus = { code: 'UNSET' };
  public attributes: Record<string, string | number | boolean> = {};

  private readonly onEnd: (span: Span) => void;
  private ended = false;

  constructor(
    name: string,
    context: TraceContext,
    parentId: string | undefined,
    startTimeMs: number,
    onEnd: (span: Span) => void
  ) {
    this.name = name;
    this.context = context;
    this.parentId = parentId;
    this.startTimeMs = startTimeMs;
    this.onEnd = onEnd;
  }

  public setAttribute(key: string, value: string | number | boolean): this {
    // Redact any secrets from attributes
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('auth') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('cookie') ||
      lowerKey.includes('password')
    ) {
      this.attributes[key] = '[REDACTED]';
    } else {
      this.attributes[key] = value;
    }
    return this;
  }

  public setStatus(code: SpanStatusCode, message?: string): this {
    this.status = { code, message };
    return this;
  }

  public end(endTimeMs?: number): void {
    if (this.ended) return; // End exactly once
    this.ended = true;

    this.endTimeMs = endTimeMs ?? Date.now();
    this.durationMs = Math.max(0, this.endTimeMs - this.startTimeMs);
    this.onEnd(this);
  }
}

export interface TracerOptions {
  sampler?: 'always_on' | 'always_off' | 'ratio';
  sampleRatio?: number;
  exporters?: SpanExporter[];
}

export class Tracer {
  private readonly sampler: 'always_on' | 'always_off' | 'ratio';
  private readonly sampleRatio: number;
  private readonly exporters: SpanExporter[] = [];

  constructor(options: TracerOptions = {}) {
    this.sampler = options.sampler ?? 'always_on';
    this.sampleRatio = options.sampleRatio ?? 1.0;
    if (options.exporters) {
      this.exporters.push(...options.exporters);
    }
  }

  public addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  public isSampled(): boolean {
    if (this.sampler === 'always_off') return false;
    if (this.sampler === 'always_on') return true;
    return Math.random() < this.sampleRatio;
  }

  public startSpan(
    name: string,
    parentContext?: TraceContext | null,
    options: { startTimeMs?: number } = {}
  ): Span {
    const isSampled = parentContext
      ? (parentContext.traceFlags & 1) === 1
      : this.isSampled();

    const traceId = parentContext ? parentContext.traceId : generateTraceId();
    const spanId = generateSpanId();
    const parentId = parentContext ? parentContext.spanId : undefined;

    const context: TraceContext = {
      traceId,
      spanId,
      traceFlags: isSampled ? 1 : 0,
      tracestate: parentContext?.tracestate,
    };

    const startTime = options.startTimeMs ?? Date.now();

    const span = new SpanImpl(name, context, parentId, startTime, (finishedSpan) => {
      if (context.traceFlags & 1) {
        for (const exporter of this.exporters) {
          try {
            exporter.export([finishedSpan]);
          } catch {}
        }
      }
    });

    return span;
  }
}
