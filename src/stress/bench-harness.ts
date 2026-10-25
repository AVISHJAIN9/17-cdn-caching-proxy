export interface BenchmarkResult {
  name: string;
  iterations: number;
  meanMs: number;
  stddevMs: number;
  p50Ms: number;
  p99Ms: number;
  opsPerSec: number;
}

export class BenchmarkHarness {
  public async runBenchmark(
    name: string,
    fn: () => void | Promise<void>,
    iterations: number = 1000,
    warmup: number = 100
  ): Promise<BenchmarkResult> {
    // Warmup
    for (let i = 0; i < warmup; i++) {
      const res = fn();
      if (res && typeof (res as any).then === 'function') await res;
    }

    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const res = fn();
      if (res && typeof (res as any).then === 'function') await res;
      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const mean = sum / times.length;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / times.length;
    const stddev = Math.sqrt(variance);

    const p50 = times[Math.floor(times.length * 0.5)];
    const p99 = times[Math.floor(times.length * 0.99)];
    const opsPerSec = mean > 0 ? 1000 / mean : 0;

    return {
      name,
      iterations,
      meanMs: parseFloat(mean.toFixed(4)),
      stddevMs: parseFloat(stddev.toFixed(4)),
      p50Ms: parseFloat(p50.toFixed(4)),
      p99Ms: parseFloat(p99.toFixed(4)),
      opsPerSec: parseFloat(opsPerSec.toFixed(0)),
    };
  }

  public checkRegression(
    current: BenchmarkResult,
    baseline: BenchmarkResult,
    maxAllowedRegressionRatio: number = 0.15
  ): { passed: boolean; ratio: number; diffPercent: number } {
    const ratio = current.meanMs / baseline.meanMs;
    const diffPercent = (ratio - 1.0) * 100;
    const passed = ratio <= 1.0 + maxAllowedRegressionRatio;
    return { passed, ratio, diffPercent: parseFloat(diffPercent.toFixed(2)) };
  }
}
