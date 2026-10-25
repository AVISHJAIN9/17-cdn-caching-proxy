import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/cache/memory-store.js';

function parsePrometheusMetrics(text: string) {
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

describe('Feature 103: Revalidation Metrics', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];
  let originVersion = 1;
  let simulateOriginError = false;

  beforeEach(async () => {
    originVersion = 1;
    simulateOriginError = false;

    originServer = http.createServer((req, res) => {
      if (simulateOriginError) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('origin failed');
        return;
      }

      const clientEtag = req.headers['if-none-match'];
      if (clientEtag === `"v-${originVersion}"`) {
        res.writeHead(304, {
          ETag: `"v-${originVersion}"`,
          'Cache-Control': 'public, max-age=1, must-revalidate',
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain',
        ETag: `"v-${originVersion}"`,
        'Cache-Control': 'public, max-age=1, must-revalidate',
      });
      res.end(`payload-version-${originVersion}`);
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

  it('Feature 103: tracks synchronous 304 Not Modified and 200 Replaced revalidation metrics', async () => {
    const metrics = new MetricsRegistry();
    const store = new MemoryStore();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      store,
      metrics,
    });
    activeProxies.push(proxy);

    // 1. Initial request: cache miss (stores v-1 with max-age=1)
    const r1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/reval-resource`);
    expect(r1.status).toBe(200);
    await r1.text();

    expect(metrics.getRevalidationsCount()).toBe(0);

    // Wait 1.1s for entry to become stale
    await new Promise((r) => setTimeout(r, 1100));

    // 2. Revalidation request: origin returns 304 Not Modified
    const r2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/reval-resource`);
    expect(r2.status).toBe(200);
    await r2.text();

    expect(metrics.getRevalidationsCount({ result: '304_not_modified', type: 'sync', tenant: 'default' })).toBe(1);

    // Wait 1.1s for entry to become stale again
    await new Promise((r) => setTimeout(r, 1100));

    // Update origin version to 2 -> origin will return 200 OK
    originVersion = 2;

    const r3 = await fetch(`http://127.0.0.1:${proxy.httpPort}/reval-resource`);
    expect(r3.status).toBe(200);
    const body3 = await r3.text();
    expect(body3).toBe('payload-version-2');

    expect(metrics.getRevalidationsCount({ result: '200_updated', type: 'sync', tenant: 'default' })).toBe(1);

    // Verify Prometheus text output
    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    expect(parsed['cdn_cache_revalidations_total']).toBeDefined();
    expect(parsed['cdn_cache_revalidations_total'].type).toBe('counter');

    const s304 = parsed['cdn_cache_revalidations_total'].samples.find(
      (s) => s.labels.result === '304_not_modified' && s.labels.type === 'sync'
    );
    expect(s304?.value).toBe(1);

    const s200 = parsed['cdn_cache_revalidations_total'].samples.find(
      (s) => s.labels.result === '200_updated' && s.labels.type === 'sync'
    );
    expect(s200?.value).toBe(1);
  });

  it('Feature 103: records direct metric invocations and background/stale_fallback outcomes', async () => {
    const metrics = new MetricsRegistry();

    metrics.recordRevalidation({ result: '304_not_modified', type: 'background', tenant: 'tenant-a' });
    metrics.recordRevalidation({ result: '200_updated', type: 'background', tenant: 'tenant-a' });
    metrics.recordRevalidation({ result: 'stale_fallback', type: 'sync', tenant: 'tenant-a' });
    metrics.recordRevalidation({ result: 'failed', type: 'sync', tenant: 'tenant-b' });

    expect(metrics.getRevalidationsCount({ result: '304_not_modified', type: 'background', tenant: 'tenant-a' })).toBe(1);
    expect(metrics.getRevalidationsCount({ result: '200_updated', type: 'background', tenant: 'tenant-a' })).toBe(1);
    expect(metrics.getRevalidationsCount({ result: 'stale_fallback', type: 'sync', tenant: 'tenant-a' })).toBe(1);
    expect(metrics.getRevalidationsCount({ result: 'failed', type: 'sync', tenant: 'tenant-b' })).toBe(1);

    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    const fallbackSample = parsed['cdn_cache_revalidations_total'].samples.find(
      (s) => s.labels.result === 'stale_fallback' && s.labels.type === 'sync' && s.labels.tenant === 'tenant-a'
    );
    expect(fallbackSample?.value).toBe(1);
  });
});
