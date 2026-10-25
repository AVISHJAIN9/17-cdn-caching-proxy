import { describe, it, expect } from 'vitest';
import { MetricsHistory } from '../src/admin/metrics-history.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('Feature 110: Cache-size charts', () => {
  it('tracks memory and disk tier byte usage over time', () => {
    const history = new MetricsHistory();
    const registry = new MetricsRegistry();
    const snap = history.sample(registry, 1024000, 5000000, 150);
    expect(snap.cacheBytesMemory).toBe(1024000);
    expect(snap.cacheBytesDisk).toBe(5000000);
    expect(snap.cacheObjectsCount).toBe(150);
  });
});
