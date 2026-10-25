export interface CachePolicyRule {
  id: string;
  tenant?: string;
  pathPattern?: string;
  defaultTtlSeconds?: number;
  minTtlSeconds?: number;
  maxTtlSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  staleIfErrorSeconds?: number;
  bypassCookies?: string[];
  bypassHeaders?: string[];
}

export interface EffectivePolicyResult {
  ruleId: string;
  defaultTtl: number;
  minTtl: number;
  maxTtl: number;
  swr: number;
  staleIfError: number;
  explanation: string;
}

export class CachePolicyManager {
  private readonly rules: CachePolicyRule[] = [];

  constructor(initialRules: CachePolicyRule[] = []) {
    this.rules = [...initialRules];
  }

  public getRules(): CachePolicyRule[] {
    return [...this.rules];
  }

  public addRule(rule: CachePolicyRule, dryRun: boolean = false): { success: boolean; explanation: string } {
    if (!rule.id) {
      return { success: false, explanation: 'Rule must have a valid id' };
    }
    const explanation = `Rule ${rule.id} matches ${rule.pathPattern ?? '*'}`;
    if (!dryRun) {
      this.rules.push(rule);
    }
    return { success: true, explanation };
  }

  /**
   * Resolves the effective cache policy for a given URL and tenant.
   */
  public resolvePolicy(urlStr: string, tenant: string = 'default'): EffectivePolicyResult {
    let matchedRule: CachePolicyRule | undefined;

    for (const rule of this.rules) {
      if (rule.tenant && rule.tenant !== tenant) continue;
      if (rule.pathPattern) {
        try {
          const re = new RegExp(rule.pathPattern);
          if (re.test(urlStr)) {
            matchedRule = rule;
            break;
          }
        } catch {}
      } else {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      return {
        ruleId: matchedRule.id,
        defaultTtl: matchedRule.defaultTtlSeconds ?? 300,
        minTtl: matchedRule.minTtlSeconds ?? 0,
        maxTtl: matchedRule.maxTtlSeconds ?? 86400,
        swr: matchedRule.staleWhileRevalidateSeconds ?? 60,
        staleIfError: matchedRule.staleIfErrorSeconds ?? 120,
        explanation: `Matched explicit policy rule ${matchedRule.id}`,
      };
    }

    return {
      ruleId: 'global_default',
      defaultTtl: 300,
      minTtl: 0,
      maxTtl: 86400,
      swr: 0,
      staleIfError: 0,
      explanation: 'No specific rule matched; fell back to global default policy',
    };
  }
}
