import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { AdminServer } from '../src/admin/server.js';

describe('Feature 106: Cache overview', () => {
  it('retrieves cache overview statistics via admin API', async () => {
    const admin = new AdminServer({ metricsRegistry: new MetricsRegistry() });
    const port = await admin.start(0);

    const res = await fetch(`http://127.0.0.1:${port}/admin/api/v1/overview`, {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.objectsCount).toBeDefined();

    await admin.stop();
  });
});
