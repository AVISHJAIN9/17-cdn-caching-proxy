import { describe, it, expect } from 'vitest';
import { CpuProfileSummarizer, CpuProfileData } from '../src/stress/cpu-profiler.js';

describe('Feature 139: CPU profiling', () => {
  it('parses CPU profile JSON and extracts top self-time hotspots', () => {
    const summarizer = new CpuProfileSummarizer();
    const fakeProfile: CpuProfileData = {
      startTime: 0,
      endTime: 1000,
      nodes: [
        { id: 1, callFrame: { functionName: 'cacheLookup', scriptId: '1', url: 'store.js', lineNumber: 10 }, hitCount: 80 },
        { id: 2, callFrame: { functionName: 'jsonParse', scriptId: '2', url: 'json.js', lineNumber: 5 }, hitCount: 20 },
      ],
    };

    const summary = summarizer.summarize(fakeProfile);
    expect(summary.length).toBe(2);
    expect(summary[0].functionName).toBe('cacheLookup');
    expect(summary[0].percentage).toBe(80);
  });
});
