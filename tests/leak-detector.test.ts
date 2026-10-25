import { describe, it, expect } from 'vitest';
import { MemoryLeakDetector } from '../src/stress/leak-detector.js';

describe('Feature 140: Memory profiling', () => {
  it('detects memory leaks via linear regression slope analysis and validates stable baseline', () => {
    const detector = new MemoryLeakDetector();

    // Stable usage (no leak)
    detector.recordSample(1, 10000000);
    detector.recordSample(2, 10000100);
    detector.recordSample(3, 10000050);
    const stableAnalysis = detector.analyzeSlope();
    expect(stableAnalysis.isLeaking).toBe(false);

    // Growing usage (leak fixture)
    const leakingDetector = new MemoryLeakDetector();
    for (let i = 1; i <= 10; i++) {
      leakingDetector.recordSample(i, 10000000 + i * 10000); // +10 KB per iteration
    }
    const leakAnalysis = leakingDetector.analyzeSlope();
    expect(leakAnalysis.isLeaking).toBe(true);
    expect(leakAnalysis.slopeBytesPerIteration).toBeGreaterThan(500);
  });
});
