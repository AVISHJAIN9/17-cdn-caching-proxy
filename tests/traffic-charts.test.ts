import { describe, it, expect } from 'vitest';
import { MetricsHistory } from '../src/admin/metrics-history.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 108: Traffic charts', () => {
  it('tracks traffic rates and status code breakdowns in time-series points', () => {
    const history = new MetricsHistory();
    const registry = new MetricsRegistry();
    const snap = history.sample(registry);
    expect(snap.requestsPerSec).toBeDefined();
    expect(snap.statusCodes['2xx']).toBeDefined();
  });
});
