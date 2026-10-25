import { CacheStore, CacheEntry } from '../cache/store.js';

export interface RequestDecisionRecord {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  tenant: string;
  decision: 'HIT' | 'MISS' | 'BYPASS' | 'STALE' | 'REVALIDATED';
  reason: string;
  statusCode: number;
  latencyMs: number;
  origin?: string;
  cacheKey?: string;
  headers: Record<string, string>;
}

export class RequestInspector {
  private readonly maxRecords: number;
  private readonly decisions: RequestDecisionRecord[] = [];
  private readonly store?: CacheStore;

  constructor(maxRecords: number = 1000, store?: CacheStore) {
    this.maxRecords = maxRecords;
    this.store = store;
  }

  public redactHeaders(headers?: Record<string, any>): Record<string, string> {
    const redacted: Record<string, string> = {};
    if (!headers) return redacted;
    const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie', 'x-api-key']);

    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (sensitive.has(lower)) {
        redacted[k] = '[REDACTED]';
      } else {
        redacted[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
    }
    return redacted;
  }

  public recordDecision(decision: Omit<RequestDecisionRecord, 'headers'> & { headers?: Record<string, any> }): void {
    const cleanRecord: RequestDecisionRecord = {
      ...decision,
      headers: this.redactHeaders(decision.headers),
    };

    if (this.decisions.length >= this.maxRecords) {
      this.decisions.shift();
    }
    this.decisions.push(cleanRecord);
  }

  public getDecisions(filter: { tenant?: string; decision?: string; limit?: number } = {}): RequestDecisionRecord[] {
    let list = this.decisions.filter((d) => {
      if (filter.tenant && d.tenant !== filter.tenant) return false;
      if (filter.decision && d.decision !== filter.decision) return false;
      return true;
    });

    if (filter.limit && filter.limit > 0) {
      list = list.slice(-filter.limit);
    }
    return list;
  }

  public inspectKey(keyHash: string): CacheEntry | undefined {
    return this.store?.get(keyHash);
  }
}
