import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry, classifyUpstreamError } from '../src/observability/metrics.js';

function parsePrometheusMetrics(text: string) {
  const lines = text.split('\n');
  const metrics: Record<
    string,
    {
      type?: string;
      help?: string;
      samples: Array<{ labels: Record<string, string>; value: number }>;
    }
  > = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# HELP ')) {
      const parts = trimmed.slice(7).split(' ');
      const name = parts[0];
      const help = parts.slice(1).join(' ');
      metrics[name] = metrics[name] || { samples: [] };
      metrics[name].help = help;
    } else if (trimmed.startsWith('# TYPE ')) {
      const parts = trimmed.slice(7).split(' ');
      const name = parts[0];
      const type = parts[1];
      metrics[name] = metrics[name] || { samples: [] };
      metrics[name].type = type;
    } else {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([0-9\.\-eE]+)$/.exec(trimmed);
      if (match) {
        const [_, name, rawLabels, rawVal] = match;
        const labels: Record<string, string> = {};
        if (rawLabels) {
          const pairs = rawLabels.match(/([a-zA-Z_][a-zA-Z0-9_]*)=("(?:[^"\\]|\\.)*")/g) || [];
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            const k = pair.slice(0, eqIdx);
            const v = JSON.parse(pair.slice(eqIdx + 1));
            labels[k] = v;
          }
        }
        metrics[name] = metrics[name] || { samples: [] };
        metrics[name].samples.push({ labels, value: parseFloat(rawVal) });
      }
    }
  }
  return metrics;
}

describe('Feature 104: Upstream Error Metrics', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      if (req.url === '/500-error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Origin internal error');
      } else if (req.url === '/503-error') {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service unavailable');
      } else if (req.url === '/hanging') {
        // Never respond to trigger headers timeout
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('OK');
      }
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
    for (const proxy of activeProxies) {
      await proxy.stop();
    }
    activeProxies = [];

    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('classifies upstream error codes and messages deterministically', () => {
    expect(classifyUpstreamError({ code: 'ECONNREFUSED' })).toBe('connection_refused');
    expect(classifyUpstreamError({ code: 'ENOTFOUND' })).toBe('dns_failure');
    expect(classifyUpstreamError({ code: 'EAI_AGAIN' })).toBe('dns_failure');
    expect(classifyUpstreamError({ message: 'Connect timeout' })).toBe('connect_timeout');
    expect(classifyUpstreamError({ message: 'Socket timeout' }, 'connecting')).toBe('connect_timeout');
    expect(classifyUpstreamError({ code: 'ETIMEDOUT' }, 'streaming_body')).toBe('read_timeout');
    expect(classifyUpstreamError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('tls_error');
    expect(classifyUpstreamError({ code: 'ECONNRESET' })).toBe('aborted');
    expect(classifyUpstreamError({ message: 'Unknown glitch' })).toBe('other');
  });

  it('tracks upstream 5xx errors from origin responses', async () => {
    const metricsRegistry = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      metrics: metricsRegistry,
    });
    activeProxies.push(proxy);

    const port = proxy.httpPort!;

    // Request 500 error
    const res500 = await fetch(`http://127.0.0.1:${port}/500-error`);
    expect(res500.status).toBe(500);

    // Request 503 error
    const res503 = await fetch(`http://127.0.0.1:${port}/503-error`);
    expect(res503.status).toBe(503);

    // Fetch /metrics
    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metricsText = await metricsRes.text();
    const parsed = parsePrometheusMetrics(metricsText);

    expect(parsed['cdn_upstream_errors_total']).toBeDefined();
    expect(parsed['cdn_upstream_errors_total'].type).toBe('counter');

    const errorSamples = parsed['cdn_upstream_errors_total'].samples;
    const sample5xx = errorSamples.find((s) => s.labels.error_type === '5xx');
    expect(sample5xx).toBeDefined();
    expect(sample5xx!.value).toBe(2);
  });

  it('tracks connection refused errors when origin is unreachable', async () => {
    // Find an unused local port
    const unusedPort = 59199;
    const metricsRegistry = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl: `http://127.0.0.1:${unusedPort}`,
      metrics: metricsRegistry,
    });
    activeProxies.push(proxy);

    const port = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${port}/unreachable`);
    expect(res.status).toBeGreaterThanOrEqual(500);

    const count = metricsRegistry.getUpstreamErrorsCount({
      error_type: 'connection_refused',
      origin: 'default',
    });
    expect(count).toBeGreaterThanOrEqual(1);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('cdn_upstream_errors_total{error_type="connection_refused"');
  });

  it('tracks upstream timeout errors when origin does not respond in time', async () => {
    const metricsRegistry = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      metrics: metricsRegistry,
      timeouts: {
        upstreamHeadersMs: 80, // Low timeout for testing
      },
    });
    activeProxies.push(proxy);

    const port = proxy.httpPort!;

    const res = await fetch(`http://127.0.0.1:${port}/hanging`);
    expect(res.status).toBe(504);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('cdn_upstream_errors_total');

    const totalErrors = metricsRegistry.getUpstreamErrorsCount();
    expect(totalErrors).toBeGreaterThanOrEqual(1);
  });
});
