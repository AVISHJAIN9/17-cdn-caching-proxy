import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import {
  Tracer,
  InMemorySpanExporter,
  OtlpHttpJsonSpanExporter,
  parseTraceparent,
  formatTraceparent,
  Span,
} from '../src/observability/tracing.js';

describe('Feature 93: OpenTelemetry Tracing & W3C Trace Context Propagation', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let lastOriginHeaders: http.IncomingHttpHeaders = {};
  let activeProxies: any[] = [];

  beforeEach(async () => {
    lastOriginHeaders = {};
    originServer = http.createServer((req, res) => {
      lastOriginHeaders = req.headers;

      if (req.url === '/slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('slow');
          }
        }, 100);
        return;
      }

      if (req.url === '/swr') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=1, stale-while-revalidate=60',
        });
        res.end('swr-content');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('origin-response');
    });

    await new Promise<void>((resolve) => {
      originServer.listen(0, '127.0.0.1', () => {
        const addr = originServer.address() as net.AddressInfo;
        originPort = addr.port;
        originUrl = `http://127.0.0.1:${originPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const p of activeProxies) {
      await p.stop();
    }
    activeProxies = [];
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('Feature 93: continues incoming valid W3C traceparent and injects child traceparent upstream', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_on',
      exporters: [memoryExporter],
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      tracer,
    });
    activeProxies.push(proxy);

    const clientTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const clientSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${clientTraceId}-${clientSpanId}-01`;
    const tracestate = 'vendor1=opaqueValue,vendor2=1234';

    const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/api/item`, {
      headers: {
        traceparent,
        tracestate,
      },
    });
    expect(res.status).toBe(200);

    // Verify upstream received updated child traceparent and preserved tracestate
    expect(lastOriginHeaders['traceparent']).toBeDefined();
    const upstreamParsed = parseTraceparent(lastOriginHeaders['traceparent'] as string);
    expect(upstreamParsed).not.toBeNull();
    expect(upstreamParsed?.traceId).toBe(clientTraceId);
    expect(upstreamParsed?.spanId).not.toBe(clientSpanId); // Child span ID
    expect(lastOriginHeaders['tracestate']).toBe(tracestate);

    // Verify finished spans in memory
    const spans = memoryExporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'cdn.request');
    const originSpan = spans.find((s) => s.name === 'origin.fetch');

    expect(rootSpan).toBeDefined();
    expect(rootSpan?.context.traceId).toBe(clientTraceId);
    expect(rootSpan?.parentId).toBe(clientSpanId);

    expect(originSpan).toBeDefined();
    expect(originSpan?.context.traceId).toBe(clientTraceId);
    expect(originSpan?.parentId).toBe(rootSpan?.context.spanId);
  });

  it('Feature 93: starts a fresh valid trace when incoming traceparent is invalid or all zeros', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_on',
      exporters: [memoryExporter],
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      tracer,
    });
    activeProxies.push(proxy);

    // 1. Invalid hex
    await fetch(`http://127.0.0.1:${proxy.httpPort}/bad-trace-1`, {
      headers: { traceparent: '00-not-valid-hex-0000000000000000-01' },
    });
    const upstream1 = parseTraceparent(lastOriginHeaders['traceparent'] as string);
    expect(upstream1).not.toBeNull();
    expect(upstream1?.traceId).toMatch(/^[0-9a-f]{32}$/);

    // 2. All zeros (illegal in W3C spec)
    await fetch(`http://127.0.0.1:${proxy.httpPort}/bad-trace-2`, {
      headers: { traceparent: '00-00000000000000000000000000000000-0000000000000000-01' },
    });
    const upstream2 = parseTraceparent(lastOriginHeaders['traceparent'] as string);
    expect(upstream2).not.toBeNull();
    expect(upstream2?.traceId).not.toBe('00000000000000000000000000000000');
  });

  it('Feature 93: demonstrates span nesting hierarchy (cdn.request -> cache.lookup -> origin.fetch)', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_on',
      exporters: [memoryExporter],
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      tracer,
    });
    activeProxies.push(proxy);

    await fetch(`http://127.0.0.1:${proxy.httpPort}/nested-test`);

    const spans = memoryExporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'cdn.request');
    const lookupSpan = spans.find((s) => s.name === 'cache.lookup');
    const fetchSpan = spans.find((s) => s.name === 'origin.fetch');

    expect(rootSpan).toBeDefined();
    expect(lookupSpan).toBeDefined();
    expect(fetchSpan).toBeDefined();

    // All belong to the same trace
    expect(lookupSpan?.context.traceId).toBe(rootSpan?.context.traceId);
    expect(fetchSpan?.context.traceId).toBe(rootSpan?.context.traceId);

    // Both lookup and fetch are direct children of root span
    expect(lookupSpan?.parentId).toBe(rootSpan?.context.spanId);
    expect(fetchSpan?.parentId).toBe(rootSpan?.context.spanId);
  });

  it('Feature 93: spans end exactly once with durationMs and status on success and abort', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_on',
      exporters: [memoryExporter],
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      tracer,
    });
    activeProxies.push(proxy);

    // Success request
    await fetch(`http://127.0.0.1:${proxy.httpPort}/ok`);

    // Client abort request
    await new Promise<void>((resolve) => {
      const client = net.createConnection({ host: '127.0.0.1', port: proxy.httpPort! }, () => {
        client.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 20);
      });
    });

    await new Promise((r) => setTimeout(r, 150));

    const spans = memoryExporter.getFinishedSpans();
    const rootSpans = spans.filter((s) => s.name === 'cdn.request');
    expect(rootSpans.length).toBe(2);

    for (const span of rootSpans) {
      expect(typeof span.startTimeMs).toBe('number');
      expect(typeof span.endTimeMs).toBe('number');
      expect(typeof span.durationMs).toBe('number');
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(['OK', 'ERROR']).toContain(span.status.code);
    }
  });

  it('Feature 93: redacts sensitive information from span attributes', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_on',
      exporters: [memoryExporter],
    });

    const rootSpan = tracer.startSpan('cdn.request');
    rootSpan.setAttribute('authToken', 'secret-bearer-12345');
    rootSpan.setAttribute('user_password', 'mypassword123');
    rootSpan.setAttribute('sessionCookie', 'session=abcde');
    rootSpan.setAttribute('http.method', 'GET');
    rootSpan.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans[0].attributes['authToken']).toBe('[REDACTED]');
    expect(spans[0].attributes['user_password']).toBe('[REDACTED]');
    expect(spans[0].attributes['sessionCookie']).toBe('[REDACTED]');
    expect(spans[0].attributes['http.method']).toBe('GET');
  });

  it('Feature 93: exports spans via OtlpHttpJsonSpanExporter to a local collector endpoint', async () => {
    let receivedPayload: any = null;

    // Spin up mock OTLP/HTTP collector
    const collectorServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ partialSuccess: {} }));
      });
    });

    const collectorPort = await new Promise<number>((resolve) => {
      collectorServer.listen(0, '127.0.0.1', () => {
        const addr = collectorServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

    try {
      const otlpExporter = new OtlpHttpJsonSpanExporter(
        `http://127.0.0.1:${collectorPort}/v1/traces`
      );

      const tracer = new Tracer({
        sampler: 'always_on',
        exporters: [otlpExporter],
      });

      const span = tracer.startSpan('cdn.request');
      span.setAttribute('http.method', 'POST');
      span.setStatus('OK');
      span.end();

      // Allow async export to complete
      await new Promise((r) => setTimeout(r, 80));

      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload.resourceSpans).toBeDefined();
      expect(receivedPayload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('cdn.request');
      expect(
        receivedPayload.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].key
      ).toBe('http.method');
    } finally {
      await new Promise<void>((resolve) => collectorServer.close(() => resolve()));
    }
  });

  it('Feature 93: respects sampling configuration (always_off ignores spans)', async () => {
    const memoryExporter = new InMemorySpanExporter();
    const tracer = new Tracer({
      sampler: 'always_off',
      exporters: [memoryExporter],
    });

    const span = tracer.startSpan('cdn.request');
    span.end();

    expect(memoryExporter.getFinishedSpans().length).toBe(0);
  });
});
