import { describe, it, expect } from 'vitest';
import { AdminServer } from '../src/admin/server.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 112: Origin health', () => {
  it('exposes origin health state and supports manual drain control', async () => {
    const admin = new AdminServer({ metricsRegistry: new MetricsRegistry() });
    const port = await admin.start(0);

    const originsRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/origins`, {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(originsRes.status).toBe(200);

    const drainRes = await fetch(`http://127.0.0.1:${port}/admin/api/v1/origins/origin-1/drain`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(drainRes.status).toBe(200);

    await admin.stop();
  });
});
