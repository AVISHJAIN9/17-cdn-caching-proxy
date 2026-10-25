import http from 'node:http';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

async function main() {
  const origin = http.createServer((req, res) => {
    if (req.url === '/error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('origin failed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' });
    res.end('hello from origin');
  });

  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  const originPort = (origin.address() as any).port;

  const metrics = new MetricsRegistry();
  const proxy = await createAndStartProxy({
    httpPort: 0,
    originUrl: `http://127.0.0.1:${originPort}`,
    metrics,
  });

  const proxyPort = proxy.httpPort!;
  console.log('--- LIVE PROXY & METRICS TEST ---');
  console.log('Proxy listening on port:', proxyPort);

  // 1. First request -> MISS
  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/test`);
  console.log('GET /test -> Status:', r1.status, 'X-Cache:', r1.headers.get('x-cache'));

  // 2. Second request -> HIT
  const r2 = await fetch(`http://127.0.0.1:${proxyPort}/test`);
  console.log('GET /test -> Status:', r2.status, 'X-Cache:', r2.headers.get('x-cache'));

  // 3. Error request -> 500
  const r3 = await fetch(`http://127.0.0.1:${proxyPort}/error`);
  console.log('GET /error -> Status:', r3.status);

  // 4. Fetch Prometheus metrics
  const mRes = await fetch(`http://127.0.0.1:${proxyPort}/metrics`);
  const mText = await mRes.text();
  console.log('--- PROMETHEUS METRICS OUTPUT ---');
  const filtered = mText
    .split('\n')
    .filter(
      (l) =>
        l.includes('cdn_origin_latency_seconds') ||
        l.includes('cdn_proxy_latency_seconds') ||
        l.includes('cdn_cache_evictions_total') ||
        l.includes('cdn_cache_revalidations_total') ||
        l.includes('cdn_upstream_errors_total')
    )
    .slice(0, 35)
    .join('\n');
  console.log(filtered);

  await proxy.stop();
  await new Promise<void>((r) => origin.close(() => r()));
}

main().catch(console.error);
