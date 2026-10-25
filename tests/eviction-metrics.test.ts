import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { TtlEvictor } from '../src/cache/eviction/ttl.js';
import { FakeClock } from '../src/util/clock.js';

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

describe('Feature 102: Eviction Metrics', () => {
  let originServer: http.Server;
  let originPort: number;
  let originUrl: string;
  let activeProxies: any[] = [];

  beforeEach(async () => {
    originServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(`payload-for-${req.url}`);
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

  it('Feature 102: tracks capacity-driven LRU evictions and evicted bytes in metrics and Prometheus text', async () => {
    const metrics = new MetricsRegistry();
    const store = new MemoryStore({
      maxEntries: 2, // Only 2 entries allowed
      evictionPolicy: 'lru',
    });

    const proxy = await createAndStartProxy({
      httpPort: 0,
      originUrl,
      store,
      metrics,
    });
    activeProxies.push(proxy);

    // 1. Request item A (cached)
    const rA = await fetch(`http://127.0.0.1:${proxy.httpPort}/item-a`);
    await rA.text();

    // 2. Request item B (cached)
    const rB = await fetch(`http://127.0.0.1:${proxy.httpPort}/item-b`);
    await rB.text();

    expect(metrics.getEvictionsCount({ reason: 'lru', tenant: 'default' })).toBe(0);

    // 3. Request item C (causes item-a to be evicted under LRU)
    const rC = await fetch(`http://127.0.0.1:${proxy.httpPort}/item-c`);
    await rC.text();

    const evictCount = metrics.getEvictionsCount({ reason: 'lru', tenant: 'default' });
    const evictBytes = metrics.getEvictedBytes({ reason: 'lru', tenant: 'default' });

    expect(evictCount).toBe(1);
    expect(evictBytes).toBeGreaterThan(0);

    // Verify Prometheus text output
    const promText = metrics.toPrometheusText();
    const parsed = parsePrometheusMetrics(promText);

    expect(parsed['cdn_cache_evictions_total']).toBeDefined();
    expect(parsed['cdn_cache_evictions_total'].type).toBe('counter');

    const evictSample = parsed['cdn_cache_evictions_total'].samples.find(
      (s) => s.labels.reason === 'lru' && s.labels.tenant === 'default'
    );
    expect(evictSample?.value).toBe(1);

    const bytesSample = parsed['cdn_cache_evicted_bytes_total'].samples.find(
      (s) => s.labels.reason === 'lru' && s.labels.tenant === 'default'
    );
    expect(bytesSample?.value).toBe(evictBytes);
  });

  it('Feature 102: tracks tenant quota evictions and TTL sweep evictions', async () => {
    const metrics = new MetricsRegistry();
    const clock = new FakeClock(1000000);
    const store = new MemoryStore({
      maxEntries: 100,
      tenantQuotas: {
        'tenant-limited': { maxEntries: 1 },
      },
    });
    store.setOnEvict((evt) => {
      metrics.recordEviction({ reason: evt.reason, tenant: evt.tenant }, evt.count ?? 1, evt.bytes);
    });

    // 1. Store item for tenant-limited
    store.set({
      keyHash: 'hash-1',
      keyString: '/t1',
      originId: 'default',
      namespace: 'tenant-limited',
      status: 200,
      statusMessage: 'OK',
      headers: {},
      body: Buffer.from('data-1'),
      size: 6,
      storedAt: 1000000,
      hitCount: 1,
      lastAccessedAt: 1000000,
      requestTimeMs: 1000000,
      responseTimeMs: 1000000,
      dateValueMs: 1000000,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 10000,
      lifetimeSource: 'max-age',
    });

    // 2. Store 2nd item for tenant-limited -> triggers quota eviction of hash-1
    store.set({
      keyHash: 'hash-2',
      keyString: '/t2',
      originId: 'default',
      namespace: 'tenant-limited',
      status: 200,
      statusMessage: 'OK',
      headers: {},
      body: Buffer.from('data-2'),
      size: 6,
      storedAt: 1000000,
      hitCount: 1,
      lastAccessedAt: 1000000,
      requestTimeMs: 1000000,
      responseTimeMs: 1000000,
      dateValueMs: 1000000,
      ageValueSeconds: 0,
      freshnessLifetimeMs: 10000,
      lifetimeSource: 'max-age',
    });

    expect(metrics.getEvictionsCount({ reason: 'quota', tenant: 'tenant-limited' })).toBe(1);
    expect(metrics.getEvictedBytes({ reason: 'quota', tenant: 'tenant-limited' })).toBe(6);

    // 3. TTL Evictor sweep after entry expires
    const ttlEvictor = new TtlEvictor(store, clock, (evt) => {
      metrics.recordEviction({ reason: evt.reason, tenant: evt.tenant }, evt.count ?? 1, evt.bytes);
    });

    clock.advance(50000); // 50 seconds later, past max-age
    const sweep = ttlEvictor.evictExpired();
    expect(sweep.evictedCount).toBe(1);

    expect(metrics.getEvictionsCount({ reason: 'ttl', tenant: 'tenant-limited' })).toBe(1);
  });
});
