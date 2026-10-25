import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry, escapeLabelValue } from '../src/observability/metrics.js';

function parsePrometheusText(text: string) {
  const lines = text.split('\n');
  const metrics: Record<string, { type?: string; help?: string; samples: Array<{ labels: Record<string, string>; value: number }> }> = {};

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

describe('Features 96, 97, 98, 99 & 92: Metrics and Prometheus Text Exposition', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      if (req.url === '/cacheable') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
          ETag: '"static-etag-1"',
        });
        res.end('cached response payload data');
        return;
      }

      if (req.url === '/no-cache-origin') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('fresh uncacheable payload');
        return;
      }

      if (req.url === '/range-content') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
          'Accept-Ranges': 'bytes',
          ETag: '"range-etag-1"',
        });
        res.end('0123456789abcdef');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('default');
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

  it('Feature 96 & 97: tracks exact cache hit, miss, and bypass counters under concurrency', async () => {
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
    });
    activeProxies.push(proxy);

    // Initial request: cache miss
    const r1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/cacheable`);
    await r1.text();

    // 50 concurrent requests: all cache hits
    const hitPromises = Array.from({ length: 50 }, async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/cacheable`);
      await res.text();
    });
    await Promise.all(hitPromises);

    // 10 bypass requests with Authorization header
    const bypassPromises = Array.from({ length: 10 }, async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/no-cache-origin`, {
        headers: { Authorization: 'Bearer test-token' },
      });
      await res.text();
    });
    await Promise.all(bypassPromises);

    const metricsRes = await fetch(`http://127.0.0.1:${proxy.httpPort}/metrics`);
    expect(metricsRes.status).toBe(200);
    const parsed = parsePrometheusText(await metricsRes.text());

    // Hits
    const hitSample = parsed['cdn_cache_hits_total']?.samples.find(
      (s) => s.labels.status === 'fresh'
    );
    expect(hitSample?.value).toBe(50);

    // Misses
    const missSample = parsed['cdn_cache_misses_total']?.samples.find(
      (s) => s.labels.reason === 'miss'
    );
    expect(missSample?.value).toBe(1);

    // Bypasses
    const bypassSample = parsed['cdn_cache_misses_total']?.samples.find(
      (s) => s.labels.reason === 'bypass'
    );
    expect(bypassSample?.value).toBe(10);
  });

  it('Feature 98: computes hit ratio with 0.0 on zero denominator and updates accurately', async () => {
    const registry = new MetricsRegistry();

    // Zero denominator rule
    expect(registry.getHitRatio()).toBe(0.0);
    expect(registry.getHitRatio('tenant-a')).toBe(0.0);

    // Prometheus text output initially reports 0.0
    const initialText = registry.toPrometheusText();
    const initialParsed = parsePrometheusText(initialText);
    expect(initialParsed['cdn_cache_hit_ratio'].samples[0].value).toBe(0.0);

    // Add 3 hits and 1 miss
    registry.recordHit({ status: 'fresh', tenant: 'tenant-a' });
    registry.recordHit({ status: 'fresh', tenant: 'tenant-a' });
    registry.recordHit({ status: 'stale', tenant: 'tenant-a' });
    registry.recordMiss({ reason: 'miss', tenant: 'tenant-a' });

    expect(registry.getHitRatio('tenant-a')).toBe(0.75);
    expect(registry.getHitRatio()).toBe(0.75);

    const updatedText = registry.toPrometheusText();
    const updatedParsed = parsePrometheusText(updatedText);
    const tenantSample = updatedParsed['cdn_cache_hit_ratio'].samples.find(
      (s) => s.labels.tenant === 'tenant-a'
    );
    expect(tenantSample?.value).toBe(0.75);
  });

  it('Feature 99: measures byte-hit metrics and byte hit ratio (cache vs origin)', async () => {
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
    });
    activeProxies.push(proxy);

    // 1. Fetch origin response (28 bytes)
    const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/cacheable`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    const body1 = await res1.text();
    const expectedBytes = Buffer.byteLength(body1);
    expect(expectedBytes).toBe(28);

    // 2. Fetch cache hit response (28 bytes)
    const res2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/cacheable`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    await res2.text();

    const metricsRes = await fetch(`http://127.0.0.1:${proxy.httpPort}/metrics`);
    const parsed = parsePrometheusText(await metricsRes.text());

    const cacheBytes = parsed['cdn_cache_bytes_served_total']?.samples.find(
      (s) => s.labels.source === 'cache'
    )?.value;
    const originBytes = parsed['cdn_cache_bytes_served_total']?.samples.find(
      (s) => s.labels.source === 'origin'
    )?.value;

    expect(originBytes).toBe(28);
    expect(cacheBytes).toBe(28);

    const byteHitRatio = parsed['cdn_cache_byte_hit_ratio']?.samples.find(
      (s) => s.labels.tenant === 'default'
    )?.value;
    expect(byteHitRatio).toBe(0.5);
  });

  it('Feature 92: verifies Prometheus 0.0.4 text syntax, label escaping, and cardinality boundaries', async () => {
    const registry = new MetricsRegistry();

    // Tenant with characters needing escaping: backslash, quote, newline
    const complexTenant = 'tenant\\"special\nname';
    registry.recordHit({ status: 'fresh', tenant: complexTenant });

    const promText = registry.toPrometheusText();

    // Check version and exposition syntax
    expect(promText).toContain('# HELP cdn_cache_hits_total Total number of cache hits served.');
    expect(promText).toContain('# TYPE cdn_cache_hits_total counter');
    expect(promText).toContain('# HELP cdn_cache_hit_ratio Ratio of cache hits to total requests (0.0 to 1.0).');
    expect(promText).toContain('# TYPE cdn_cache_hit_ratio gauge');

    // Label escaping check
    expect(promText).toContain('tenant="tenant\\\\\\"special\\nname"');

    // Cardinality fence check
    expect(promText).not.toContain('/cacheable');
    expect(promText).not.toContain('127.0.0.1');
  });

  it('Feature 92: protects /metrics endpoint with configured authentication and avoids cache pollution', async () => {
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      apiKeyAuth: {
        keys: [{ id: 'k-admin', key: 'admin-secret-token', tenantId: 'ops' }],
      },
    });
    activeProxies.push(proxy);

    // 1. Unauthenticated scrape -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${proxy.httpPort}/metrics`);
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated scrape -> 200
    const authRes = await fetch(`http://127.0.0.1:${proxy.httpPort}/metrics`, {
      headers: { 'X-Api-Key': 'admin-secret-token' },
    });
    expect(authRes.status).toBe(200);
    expect(authRes.headers.get('content-type')).toContain('text/plain; version=0.0.4');

    const text = await authRes.text();
    const parsed = parsePrometheusText(text);

    // Scraping /metrics does NOT increment cache hits or misses
    const freshHits = parsed['cdn_cache_hits_total']?.samples.find((s) => s.labels.status === 'fresh');
    expect(freshHits?.value ?? 0).toBe(0);
  });
});
