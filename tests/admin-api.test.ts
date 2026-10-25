import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminServer } from '../src/admin/server.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Group B: Admin API & Dashboard (Features 105–112)', () => {
  let admin: AdminServer;
  let port: number;

  beforeEach(async () => {
    admin = new AdminServer({
      metricsRegistry: new MetricsRegistry(),
      cacheStore: new MemoryStore(),
      adminToken: 'test-admin-token',
    });
    port = await admin.start(0);
  });

  afterEach(async () => {
    await admin.stop();
  });

  it('Feature 105: returns system status with auth and serves dashboard HTML with strict CSP', async () => {
    // 1. Dashboard HTML
    const dashRes = await fetch(`http://127.0.0.1:${port}/admin/dashboard`);
    expect(dashRes.status).toBe(200);
    const html = await dashRes.text();
    expect(html).toContain('Operations Dashboard');
    expect(dashRes.headers.get('content-security-policy')).toContain("default-src 'self'");

    // 2. Unauthenticated API request -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/status`);
    expect(unauthRes.status).toBe(401);

    // 3. Authenticated status -> 200
    const authRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/status`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(authRes.status).toBe(200);
    const data = await authRes.json();
    expect(data.status).toBe('healthy');
  });

  it('Feature 106: serves cache overview metrics', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/v1/overview`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.objectsCount).toBeDefined();
    expect(data.hitRatio).toBeDefined();
  });

  it('Features 107–111: serves time-series metrics points for charts', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/v1/timeseries/hit-ratio`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.points)).toBe(true);
  });

  it('Feature 112: inspects origin health and performs manual origin drain', async () => {
    const listRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/origins`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(listRes.status).toBe(200);

    const drainRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/origins/origin-primary/drain`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(drainRes.status).toBe(200);
    const drainData = await drainRes.json();
    expect(drainData.drained).toBe(true);
  });
});
