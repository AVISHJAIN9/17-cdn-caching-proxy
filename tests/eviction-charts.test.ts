import { describe, it, expect } from 'vitest';
import { MetricsHistory } from '../src/admin/metrics-history.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 111: Eviction charts', () => {
  it('samples and exposes eviction rates over time', () => {
    const history = new MetricsHistory();
    const registry = new MetricsRegistry();
    const snap = history.sample(registry);
    expect(snap.evictionsPerSec).toBeDefined();
  });
});
