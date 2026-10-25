export interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

export interface CpuProfileData {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export class CpuProfileSummarizer {
  public summarize(profile: CpuProfileData): Array<{ functionName: string; hits: number; percentage: number }> {
    const hitsMap = new Map<string, number>();
    let totalHits = 0;

    for (const node of profile.nodes) {
      const fn = node.callFrame.functionName || '(anonymous)';
      const hits = node.hitCount ?? 0;
      hitsMap.set(fn, (hitsMap.get(fn) ?? 0) + hits);
      totalHits += hits;
    }

    const results = Array.from(hitsMap.entries())
      .map(([functionName, hits]) => ({
        functionName,
        hits,
        percentage: totalHits > 0 ? parseFloat(((hits / totalHits) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.hits - a.hits);

    return results;
  }
}
