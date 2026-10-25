export interface MemorySample {
  iteration: number;
  heapUsedBytes: number;
  timestamp: number;
}

export class MemoryLeakDetector {
  private readonly samples: MemorySample[] = [];

  public recordSample(iteration: number, heapUsedBytes: number): void {
    this.samples.push({
      iteration,
      heapUsedBytes,
      timestamp: Date.now(),
    });
  }

  /**
   * Fits a linear regression slope (bytes / iteration) across recorded heap samples.
   * A slope > threshold indicates a persistent memory leak.
   */
  public analyzeSlope(): { slopeBytesPerIteration: number; isLeaking: boolean } {
    if (this.samples.length < 2) {
      return { slopeBytesPerIteration: 0, isLeaking: false };
    }

    const n = this.samples.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (const s of this.samples) {
      sumX += s.iteration;
      sumY += s.heapUsedBytes;
      sumXY += s.iteration * s.heapUsedBytes;
      sumX2 += s.iteration * s.iteration;
    }

    const numerator = n * sumXY - sumX * sumY;
    const denominator = n * sumX2 - sumX * sumX;

    const slope = denominator !== 0 ? numerator / denominator : 0;
    // If slope exceeds 500 bytes per request/iteration, flag leak
    const isLeaking = slope > 500;

    return {
      slopeBytesPerIteration: parseFloat(slope.toFixed(2)),
      isLeaking,
    };
  }
}
