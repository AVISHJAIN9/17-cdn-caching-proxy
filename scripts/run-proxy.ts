import { createAndStartProxy } from '../src/proxy/index.js';
import { AdminServer } from '../src/admin/server.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/cache/memory-store.js';

async function main() {
  const proxyPort = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 8080;
  const adminPort = process.env.ADMIN_PORT ? parseInt(process.env.ADMIN_PORT, 10) : 9090;
  const adminToken = process.env.ADMIN_TOKEN || 'admin-secret';

  const sharedMetrics = new MetricsRegistry();
  const sharedStore = new MemoryStore({
    maxTotalBytes: 512 * 1024 * 1024, // 512 MB
    maxObjectBytes: 32 * 1024 * 1024,  // 32 MB
  });

  // Start Admin Server on 9090
  const adminServer = new AdminServer({
    metricsRegistry: sharedMetrics,
    cacheStore: sharedStore,
    adminToken,
  });
  await adminServer.start(adminPort, '0.0.0.0');
  console.log(`[cdn-admin] Admin API & Live Dashboard listening on http://0.0.0.0:${adminPort}/admin`);

  // Start Reverse Proxy on 8080
  const proxyListener = await createAndStartProxy({
    httpPort: proxyPort,
    store: sharedStore,
    metrics: sharedMetrics,
    originsConfig: {
      origins: {
        'origin-primary': { url: process.env.ORIGIN_PRIMARY_URL || 'http://127.0.0.1:8001' },
        'origin-secondary': { url: process.env.ORIGIN_SECONDARY_URL || 'http://127.0.0.1:8002' },
        'origin-backup': { url: process.env.ORIGIN_BACKUP_URL || 'http://127.0.0.1:8003' },
      },
      defaultOrigin: 'origin-primary',
      pools: {
        'primary-pool': {
          algorithm: 'weighted-round-robin',
          members: [
            { origin: 'origin-primary', weight: 80 },
            { origin: 'origin-secondary', weight: 20 },
          ],
        },
      },
    },
    attachProcessHandlers: true,
  });

  console.log(`[cdn-proxy] Reverse Proxy listening on http://0.0.0.0:${proxyPort}`);

  // Periodic metrics sampling
  const sampleInterval = setInterval(() => {
    adminServer.metricsHistory.sample(
      sharedMetrics,
      sharedStore.stats().totalBytes,
      0,
      sharedStore.stats().entries
    );
  }, 2000);

  const shutdown = async () => {
    console.log('[cdn] Shutting down cleanly...');
    clearInterval(sampleInterval);
    await adminServer.stop();
    await proxyListener.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[cdn] Fatal error on startup:', err);
  process.exit(1);
});
