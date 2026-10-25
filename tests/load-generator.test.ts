import { describe, it, expect } from 'vitest';
import { ZipfGenerator, LatencyHistogram } from '../src/stress/load-generator.js';

describe('Feature 137: Load testing', () => {
  it('generates Zipfian key distribution with skew and computes accurate latency percentiles', () => {
    const zipf = new ZipfGenerator(100, 0.99);
    const counts = new Map<number, number>();

    for (let i = 0; i < 10000; i++) {
      const k = zipf.next();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    // Rank 1 must have substantially more requests than Rank 50 (Zipfian power law)
    expect(counts.get(1)!).toBeGreaterThan(counts.get(50)!);

    // Histogram percentile check
    const hist = new LatencyHistogram();
    for (let i = 1; i <= 100; i++) hist.record(i);
    expect(hist.getPercentile(50)).toBeGreaterThanOrEqual(50);
    expect(hist.getPercentile(50)).toBeLessThanOrEqual(51);
    expect(hist.getPercentile(99)).toBeGreaterThanOrEqual(99);
  });
});
