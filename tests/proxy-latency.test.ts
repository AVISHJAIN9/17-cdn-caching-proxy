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

describe('Feature 101: Proxy Latency Metrics', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=60',
          });
          res.end('slow payload');
        }, 25);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=60',
      });
      res.end('fast payload');
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

  it('Feature 101: records proxy end-to-end latency segmented by cache_status for hits and misses', async () => {
    const metrics = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      metrics,
    });
    activeProxies.push(proxy);

    // 1. Initial request (MISS): takes at least 25ms
    const r1 = await fetch(`http://127.0.0.1:${proxy.httpPort}/slow`);
    expect(r1.status).toBe(200);
    await r1.text();

    const missStats = metrics.getProxyLatencyStats({ cache_status: 'MISS', tenant: 'default' });
    expect(missStats).toBeDefined();
    expect(missStats?.count).toBe(1);
    expect(missStats?.sum).toBeGreaterThanOrEqual(0.020);

    // 2. Subsequent request (HIT): served from cache rapidly
    const r2 = await fetch(`http://127.0.0.1:${proxy.httpPort}/slow`);
    expect(r2.status).toBe(200);
    await r2.text();

    const hitStats = metrics.getProxyLatencyStats({ cache_status: 'HIT', tenant: 'default' });
    expect(hitStats).toBeDefined();
    expect(hitStats?.count).toBe(1);
    expect(hitStats?.sum).toBeGreaterThan(0);

    // 3. Verify Prometheus format output
    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    expect(parsed['cdn_proxy_latency_seconds']).toBeDefined();
    expect(parsed['cdn_proxy_latency_seconds'].type).toBe('histogram');

    const bucketSamples = parsed['cdn_proxy_latency_seconds_bucket'].samples;
    expect(bucketSamples.length).toBeGreaterThan(0);

    // Check HIT Inf bucket
    const hitInf = bucketSamples.find((s) => s.labels.cache_status === 'HIT' && s.labels.le === '+Inf');
    expect(hitInf?.value).toBe(1);

    // Check MISS Inf bucket
    const missInf = bucketSamples.find((s) => s.labels.cache_status === 'MISS' && s.labels.le === '+Inf');
    expect(missInf?.value).toBe(1);

    const hitCount = parsed['cdn_proxy_latency_seconds_count'].samples.find(
      (s) => s.labels.cache_status === 'HIT'
    );
    expect(hitCount?.value).toBe(1);

    const missCount = parsed['cdn_proxy_latency_seconds_count'].samples.find(
      (s) => s.labels.cache_status === 'MISS'
    );
    expect(missCount?.value).toBe(1);
  });

  it('Feature 101: records proxy latency on client abort and error paths', async () => {
    const metrics = new MetricsRegistry();
    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      metrics,
    });
    activeProxies.push(proxy);

    // Client abort connection
    await new Promise<void>((resolve) => {
      const client = net.createConnection({ host: '127.0.0.1', port: proxy.httpPort! }, () => {
        client.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 10);
      });
    });

    // Wait 50ms for proxy finalizeRequest to execute on abort
    await new Promise((r) => setTimeout(r, 60));

    const missStats = metrics.getProxyLatencyStats({ cache_status: 'MISS', tenant: 'default' });
    expect(missStats).toBeDefined();
    expect(missStats?.count).toBe(1);
  });
});
