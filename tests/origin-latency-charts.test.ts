import { describe, it, expect } from 'vitest';
import { MetricsHistory } from '../src/admin/metrics-history.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 109: Origin latency charts', () => {
  it('records origin latency percentiles (p50, p95, p99) for time-series charts', () => {
    const history = new MetricsHistory();
    const registry = new MetricsRegistry();
    const snap = history.sample(registry);
    expect(snap.originLatencyP50).toBeGreaterThan(0);
    expect(snap.originLatencyP95).toBeGreaterThan(snap.originLatencyP50);
  });
});
