import { describe, it, expect } from 'vitest';
import { BenchmarkHarness } from '../src/stress/bench-harness.js';

describe('Feature 138: Benchmark harness', () => {
  it('runs iterations, computes statistical percentiles, and detects performance regressions', async () => {
    const harness = new BenchmarkHarness();

    const baseline = await harness.runBenchmark('baseline-noop', () => {
      let x = 0;
      for (let i = 0; i < 100; i++) x += i;
    }, 500, 50);

    expect(baseline.meanMs).toBeDefined();
    expect(baseline.p50Ms).toBeDefined();

    // Check passing regression
    const checkPass = harness.checkRegression(baseline, baseline, 0.15);
    expect(checkPass.passed).toBe(true);

    // Check failing regression
    const degraded = { ...baseline, meanMs: baseline.meanMs * 1.5 };
    const checkFail = harness.checkRegression(degraded, baseline, 0.15);
    expect(checkFail.passed).toBe(false);
  });
});
