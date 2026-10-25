import { describe, it, expect } from 'vitest';
import { MetricsHistory } from '../src/admin/metrics-history.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 107: Hit-ratio charts', () => {
  it('samples and outputs hit ratio time-series points', () => {
    const history = new MetricsHistory();
    const registry = new MetricsRegistry();
    const snap = history.sample(registry);
    expect(snap.hitRatio).toBeDefined();

    const points = history.getTimeseries();
    expect(points.length).toBe(1);
  });
});
