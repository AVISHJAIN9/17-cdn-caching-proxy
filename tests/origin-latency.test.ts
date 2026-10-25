import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

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

describe('Feature 100: Origin Latency Metrics', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      if (req.url === '/delayed') {
        setTimeout(() => {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=60',
          });
          res.end('delayed response');
        }, 30);
        return;
      }

      if (req.url === '/fast') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
        });
        res.end('fast response');
        return;
      }

      if (req.url === '/error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('server error');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
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

  it('Feature 100: records origin latency for misses and verifies cumulative histogram buckets in Prometheus output', async () => {
    const metrics = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      metrics,
    });
    activeProxies.push(proxy);

    // Initial request: cache miss (triggers origin fetch with ~30ms delay)
    const res1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/delayed`);
    expect(res1.status).toBe(200);
    await res1.text();

    const originStats = metrics.getOriginLatencyStats({ origin: 'default', tenant: 'default' });
    expect(originStats).toBeDefined();
    expect(originStats?.count).toBe(1);
    expect(originStats?.sum).toBeGreaterThanOrEqual(0.025); // At least 25ms observed

    // Second request: cache hit (should NOT record origin latency)
    const res2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/delayed`);
    expect(res2.status).toBe(200);
    await res2.text();

    const originStatsAfterHit = metrics.getOriginLatencyStats({ origin: 'default', tenant: 'default' });
    expect(originStatsAfterHit?.count).toBe(1); // Unchanged

    // Third request: fresh miss on /fast
    const res3 = await fetch(`http://127.0.0.1:${proxy.httpPort}/fast`);
    expect(res3.status).toBe(200);
    await res3.text();

    const originStatsAfterMiss = metrics.getOriginLatencyStats({ origin: 'default', tenant: 'default' });
    expect(originStatsAfterMiss?.count).toBe(2);

    // Verify Prometheus text output format
    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    expect(parsed['cdn_origin_latency_seconds']).toBeDefined();
    expect(parsed['cdn_origin_latency_seconds'].type).toBe('histogram');

    const bucketSamples = parsed['cdn_origin_latency_seconds_bucket'].samples;
    expect(bucketSamples.length).toBeGreaterThan(0);

    // Buckets must be monotonically increasing
    let prevVal = 0;
    for (const b of bucketSamples) {
      expect(b.value).toBeGreaterThanOrEqual(prevVal);
      prevVal = b.value;
    }

    // The +Inf bucket must equal the count
    const infBucket = bucketSamples.find((s) => s.labels.le === '+Inf');
    expect(infBucket).toBeDefined();
    expect(infBucket?.value).toBe(2);

    const countSample = parsed['cdn_origin_latency_seconds_count'].samples.find(
      (s) => s.labels.origin === 'default'
    );
    expect(countSample?.value).toBe(2);

    const sumSample = parsed['cdn_origin_latency_seconds_sum'].samples.find(
      (s) => s.labels.origin === 'default'
    );
    expect(sumSample?.value).toBeGreaterThanOrEqual(0.025);
  });

  it('Feature 100: bounds origin label and separates latency by origin name', async () => {
    const metrics = new MetricsRegistry();
    metrics.recordOriginLatency({ origin: 'origin-alpha', tenant: 'tenant-1' }, 0.045);
    metrics.recordOriginLatency({ origin: 'origin-beta', tenant: 'tenant-1' }, 0.120);

    const statsAlpha = metrics.getOriginLatencyStats({ origin: 'origin-alpha', tenant: 'tenant-1' });
    const statsBeta = metrics.getOriginLatencyStats({ origin: 'origin-beta', tenant: 'tenant-1' });

    expect(statsAlpha?.count).toBe(1);
    expect(statsAlpha?.sum).toBeCloseTo(0.045, 3);

    expect(statsBeta?.count).toBe(1);
    expect(statsBeta?.sum).toBeCloseTo(0.120, 3);

    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    const countAlpha = parsed['cdn_origin_latency_seconds_count'].samples.find(
      (s) => s.labels.origin === 'origin-alpha' && s.labels.tenant === 'tenant-1'
    );
    expect(countAlpha?.value).toBe(1);

    const countBeta = parsed['cdn_origin_latency_seconds_count'].samples.find(
      (s) => s.labels.origin === 'origin-beta' && s.labels.tenant === 'tenant-1'
    );
    expect(countBeta?.value).toBe(1);
  });
});
