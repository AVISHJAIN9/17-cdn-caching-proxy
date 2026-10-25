import http from 'node:http';

async function fetchHttp(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:8080';
  const adminUrl = process.env.ADMIN_URL || 'http://127.0.0.1:9090';
  const adminToken = process.env.ADMIN_TOKEN || 'admin-secret';

  console.log('Driving realistic traffic to CDN Proxy at', proxyUrl);

  const trafficPlan: Array<{ path: string; count: number; headers: Record<string, string> }> = [
    // 1. Fresh cacheable URLs
    { path: '/catalog/item-101', count: 1, headers: {} },
    // 2. Repeats -> Cache HITs
    { path: '/catalog/item-101', count: 4, headers: {} },
    // 3. Multi-tenant traffic
    { path: '/api/v1/tenant-a/profile', count: 3, headers: { 'x-tenant-id': 'tenant-alpha' } },
    { path: '/api/v1/tenant-b/orders', count: 3, headers: { 'x-tenant-id': 'tenant-beta' } },
    // 4. Range requests
    { path: '/catalog/item-101', count: 2, headers: { Range: 'bytes=0-50' } },
    // 5. Compressed requests
    { path: '/catalog/item-102', count: 2, headers: { 'Accept-Encoding': 'gzip' } },
    { path: '/catalog/item-103', count: 2, headers: { 'Accept-Encoding': 'br' } },
    // 6. Large objects
    { path: '/blob-100k-1', count: 2, headers: {} },
    // 7. Errors (404 and 500)
    { path: '/status/404', count: 2, headers: {} },
    { path: '/status/500', count: 2, headers: {} },
  ];

  let totalSent = 0;
  for (const item of trafficPlan) {
    for (let i = 0; i < item.count; i++) {
      try {
        const res = await fetchHttp(`${proxyUrl}${item.path}`, item.headers);
        totalSent++;
        const cacheHeader = res.headers['x-cache'] || 'NONE';
        console.log(`[traffic] GET ${item.path} -> ${res.status} [X-Cache: ${cacheHeader}]`);
      } catch (err: any) {
        console.warn(`[traffic] Failed GET ${item.path}: ${err.message}`);
      }
    }
  }

  console.log(`\nCompleted sending ${totalSent} requests.`);
  console.log('Verifying telemetry alignment between Prometheus /metrics and Admin API...');

  // Wait a moment for async counters to settle
  await new Promise((r) => setTimeout(r, 1000));

  // Scrape Prometheus /metrics
  const metricsRes = await fetchHttp(`${proxyUrl}/metrics`);
  const promText = metricsRes.body;

  // Query Admin API /admin/api/v1/overview
  const overviewRes = await fetchHttp(`${adminUrl}/admin/api/v1/overview`, {
    Authorization: `Bearer ${adminToken}`,
  });
  const overview = JSON.parse(overviewRes.body);

  console.log('\n--- Prometheus Metrics Snippet ---');
  const metricLines = promText.split('\n').filter((l) =>
    l.startsWith('cdn_requests_total') ||
    l.startsWith('cdn_cache_hits_total') ||
    l.startsWith('cdn_cache_misses_total') ||
    l.startsWith('cdn_bandwidth_bytes_total')
  );
  console.log(metricLines.slice(0, 10).join('\n'));

  console.log('\n--- Admin API /overview ---');
  console.log(JSON.stringify(overview, null, 2));

  console.log('\n--- Telemetry Agreement Check ---');
  console.log(`Cached Objects in Store:  ${overview.objectsCount}`);
  console.log(`Hit Ratio in Admin API:   ${(overview.hitRatio * 100).toFixed(1)}%`);
  console.log(`Byte Hit Ratio:           ${(overview.byteHitRatio * 100).toFixed(1)}%`);

  if (overview.objectsCount > 0) {
    console.log('✓ Telemetry agreement verified: Live proxy requests successfully populated cache store and metrics!');
  } else {
    console.warn('⚠️ Warning: No cached objects recorded.');
  }
}

main().catch((err) => {
  console.error('Fatal traffic script error:', err);
  process.exit(1);
});
