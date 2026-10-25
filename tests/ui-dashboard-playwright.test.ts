import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser, Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { AdminServer } from '../src/admin/server.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 105-117: Real Browser Frontend Verification with Playwright', () => {
  let adminServer: AdminServer;
  let adminPort: number;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  const screenshotDir = path.resolve(__dirname, '../docs/screenshots');

  beforeAll(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });

    // Setup real backend admin server with sample live state
    const metrics = new MetricsRegistry();
    metrics.recordHit({ status: 'fresh', tenant: 'tenant-1' });
    metrics.recordMiss({ reason: 'miss', tenant: 'tenant-1' });
    metrics.recordBytes({ source: 'cache', bytes: 1024, tenant: 'tenant-1' });

    const store = new MemoryStore({
      maxTotalBytes: 64 * 1024 * 1024,
    });
    const body = Buffer.from('sample payload');
    store.set({
      keyHash: 'k1-hash',
      keyString: '/sample',
      originId: 'origin-primary',
      status: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain' },
      body,
      size: body.length,
      storedAt: Date.now(),
      hitCount: 1,
      lastAccessedAt: Date.now(),
      requestTimeMs: Date.now() - 50,
      responseTimeMs: Date.now(),
      dateValueMs: Date.now(),
      ageValueSeconds: 0,
      freshnessLifetimeMs: 60000,
      lifetimeSource: 'max-age',
    });

    adminServer = new AdminServer({
      metricsRegistry: metrics,
      cacheStore: store,
      adminToken: 'admin-secret',
    });

    // Seed sample time-series data
    adminServer.metricsHistory.sample(metrics, 204800, 0, 1);

    // Seed sample request inspection decisions
    adminServer.inspector.recordDecision({
      id: 'req-1',
      timestamp: Date.now(),
      method: 'GET',
      url: '/catalog/item-42',
      tenant: 'default',
      decision: 'HIT',
      reason: 'fresh_cache_hit',
      origin: 'memory-store',
      cacheKey: 'item-42-hash',
      statusCode: 200,
      latencyMs: 12,
      headers: {},
    });
    adminServer.inspector.recordDecision({
      id: 'req-2',
      timestamp: Date.now(),
      method: 'GET',
      url: '/api/v1/users',
      tenant: 'default',
      decision: 'MISS',
      reason: 'cache_miss',
      origin: 'origin-primary',
      cacheKey: 'users-hash',
      statusCode: 200,
      latencyMs: 45,
      headers: {},
    });

    adminPort = await adminServer.start(0, '127.0.0.1');

    // Launch headless Chromium via Playwright
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()}: ${req.failure()?.errorText}`);
    });

    await page.goto(`http://127.0.0.1:${adminPort}/admin`, { waitUntil: 'domcontentloaded' });
  }, 30000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (adminServer) await adminServer.stop();
  });

  it('Feature 105: CDN dashboard app shell, header, and token authentication', async () => {
    const title = await page.title();
    expect(title).toContain('CDN Caching Proxy');

    const header = await page.textContent('.logo');
    expect(header).toContain('CDN Caching Proxy Admin');

    const tokenInput = await page.$('#admin-token');
    expect(tokenInput).not.toBeNull();

    await page.screenshot({ path: path.join(screenshotDir, 'f105_dashboard_shell.png') });
  });

  it('Feature 106: Cache overview cards with live backend metrics', async () => {
    // Wait for live poll to populate overview metrics
    await page.waitForFunction(() => {
      const el = document.getElementById('metric-objects');
      return el && el.textContent !== '0';
    }, { timeout: 5000 });

    const objectsText = await page.textContent('#metric-objects');
    expect(parseInt(objectsText || '0', 10)).toBeGreaterThan(0);

    const hitRatioText = await page.textContent('#metric-hit-ratio');
    expect(hitRatioText).toMatch(/%/);

    await page.screenshot({ path: path.join(screenshotDir, 'f106_cache_overview.png') });
  });

  it('Feature 107 & 108: Hit-ratio and traffic charts over time', async () => {
    await page.click('button[data-tab="traffic"]');
    await page.waitForTimeout(300);

    const hitRatioSvg = await page.$('#chart-hit-ratio');
    expect(hitRatioSvg).not.toBeNull();

    const trafficSvg = await page.$('#chart-traffic');
    expect(trafficSvg).not.toBeNull();

    await page.screenshot({ path: path.join(screenshotDir, 'f107_f108_traffic_charts.png') });
  });

  it('Feature 109 & 112: Origin latency charts and origin health with live drain toggle', async () => {
    await page.click('button[data-tab="latency"]');
    await page.waitForTimeout(300);

    const latencySvg = await page.$('#chart-latency');
    expect(latencySvg).not.toBeNull();

    // Verify origin table
    const tableOrigins = await page.textContent('#table-origins');
    expect(tableOrigins).toContain('origin-primary');

    // Click Drain on origin-primary
    const drainBtn = await page.$('#table-origins button');
    expect(drainBtn).not.toBeNull();
    await drainBtn!.click();

    // Wait for state to reflect DRAINED
    await page.waitForFunction(() => {
      return document.querySelector('#table-origins')?.textContent?.includes('DRAINED');
    }, { timeout: 10000 });

    await page.screenshot({ path: path.join(screenshotDir, 'f109_f112_origin_health_drain.png') });
  }, 15000);

  it('Feature 110 & 111: Cache-size and eviction telemetry charts', async () => {
    await page.click('button[data-tab="storage"]');
    await page.waitForTimeout(300);

    const sizeSvg = await page.$('#chart-cache-size');
    expect(sizeSvg).not.toBeNull();

    const evictSvg = await page.$('#chart-evictions');
    expect(evictSvg).not.toBeNull();

    await page.screenshot({ path: path.join(screenshotDir, 'f110_f111_cache_size_evictions.png') });
  });

  it('Feature 113: Route configuration inspection and interactive update', async () => {
    await page.click('button[data-tab="routes"]');
    await page.waitForTimeout(300);

    await page.fill('#route-path', '/api/v2/*');
    await page.fill('#route-origin', 'origin-backup');
    await page.click('#btn-save-route');

    // Wait for banner confirmation
    await page.waitForFunction(() => {
      const banner = document.getElementById('alert-banner');
      return banner && banner.textContent?.includes('applied successfully');
    }, { timeout: 10000 });

    // Verify route appears in active table
    const routesContent = await page.textContent('#table-routes');
    expect(routesContent).toContain('/api/v2/*');

    await page.screenshot({ path: path.join(screenshotDir, 'f113_route_config.png') });
  }, 15000);

  it('Feature 114: Cache policy editor with interactive resolver', async () => {
    await page.click('button[data-tab="policies"]');
    await page.waitForTimeout(300);

    await page.fill('#policy-url', '/images/avatar.jpg');
    await page.fill('#policy-tenant', 'tenant-enterprise');
    await page.click('#btn-resolve-policy');

    await page.waitForFunction(() => {
      const res = document.getElementById('policy-result');
      return res && res.textContent?.includes('defaultTtl');
    }, { timeout: 5000 });

    const result = await page.textContent('#policy-result');
    expect(result).toContain('defaultTtl');

    await page.screenshot({ path: path.join(screenshotDir, 'f114_policy_resolver.png') });
  });

  it('Feature 115: Purge interface with execution and live audit trail', async () => {
    await page.click('button[data-tab="purge"]');
    await page.waitForTimeout(300);

    await page.fill('#purge-target', '/catalog/special-offer');
    await page.click('#btn-submit-purge');

    await page.waitForFunction(() => {
      const out = document.getElementById('purge-output');
      const audit = document.getElementById('table-audit');
      return out && out.textContent?.includes('Result') && audit && audit.textContent?.includes('/catalog/special-offer');
    }, { timeout: 5000 });

    const auditContent = await page.textContent('#table-audit');
    expect(auditContent).toContain('/catalog/special-offer');

    await page.screenshot({ path: path.join(screenshotDir, 'f115_purge_audit.png') });
  });

  it('Feature 116: Tenant view with quota usage and namespace breakdown', async () => {
    await page.click('button[data-tab="tenants"]');
    await page.waitForTimeout(300);

    const tableTenants = await page.textContent('#table-tenants');
    expect(tableTenants).toContain('default');
    expect(tableTenants).toContain('tenant-enterprise');

    await page.screenshot({ path: path.join(screenshotDir, 'f116_tenant_view.png') });
  });

  it('Feature 117: Request inspection live decisions buffer', async () => {
    await page.click('button[data-tab="inspect"]');
    await page.waitForTimeout(300);

    const inspectContent = await page.textContent('#table-inspect');
    expect(inspectContent).toContain('/catalog/item-42');
    expect(inspectContent).toContain('HIT');
    expect(inspectContent).toContain('/api/v1/users');
    expect(inspectContent).toContain('MISS');

    await page.screenshot({ path: path.join(screenshotDir, 'f117_request_inspection.png') });

    if (consoleErrors.length > 0) {
      console.log('Uncaught browser console errors:', consoleErrors);
    }
    if (failedRequests.length > 0) {
      console.log('Failed network requests:', failedRequests);
    }

    // Assert zero uncaught browser console errors
    expect(consoleErrors).toHaveLength(0);
    // Assert zero failed network requests
    expect(failedRequests).toHaveLength(0);
  });
});
