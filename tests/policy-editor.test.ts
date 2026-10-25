import { describe, it, expect } from 'vitest';
import { CachePolicyManager } from '../src/admin/policy-manager.js';

describe('Feature 114: Cache policy editor', () => {
  it('resolves effective cache policy with precedence and explains winning rule', () => {
    const manager = new CachePolicyManager();
    manager.addRule({
      id: 'static-assets',
      pathPattern: '\\.(jpg|jpeg|png|gif|css|js)$',
      defaultTtlSeconds: 86400,
      staleWhileRevalidateSeconds: 300,
    });

    const res1 = manager.resolvePolicy('http://example.com/logo.png');
    expect(res1.ruleId).toBe('static-assets');
    expect(res1.defaultTtl).toBe(86400);

    const res2 = manager.resolvePolicy('http://example.com/dynamic-feed');
    expect(res2.ruleId).toBe('global_default');
  });
});
