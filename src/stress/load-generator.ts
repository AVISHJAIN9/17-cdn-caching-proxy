export class ZipfGenerator {
  private readonly n: number;
  private readonly s: number;
  private readonly cdf: number[];

  constructor(n: number = 1000, s: number = 0.99) {
    this.n = n;
    this.s = s;
    this.cdf = new Array(n);

    let sum = 0;
    for (let i = 1; i <= n; i++) {
      sum += 1.0 / Math.pow(i, s);
    }

    let acc = 0;
    for (let i = 1; i <= n; i++) {
      acc += (1.0 / Math.pow(i, s)) / sum;
      this.cdf[i - 1] = acc;
    }
  }

  public next(): number {
    const r = Math.random();
    let low = 0;
    let high = this.n - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.cdf[mid] >= r) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low + 1;
  }
}

export class LatencyHistogram {
  private readonly values: number[] = [];

  public record(valMs: number): void {
    this.values.push(valMs);
  }

  public getPercentile(p: number): number {
    if (this.values.length === 0) return 0;
    this.values.sort((a, b) => a - b);
    const idx = Math.min(this.values.length - 1, Math.floor((p / 100) * this.values.length));
    return this.values[idx];
  }

  public count(): number {
    return this.values.length;
  }
}
