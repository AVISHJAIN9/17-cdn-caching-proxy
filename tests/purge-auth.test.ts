import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeAuditTrail } from '../src/purge/audit.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';
import { PurgeApiHandler } from '../src/purge/api.js';

describe('Feature 124: Purge auth', () => {
  it('enforces RBAC scope check and tenant binding', () => {
    const index = new PurgeIndex();
    const audit = new PurgeAuditTrail();
    const queue = new PurgeJobQueue(index);
    const api = new PurgeApiHandler(index, queue, audit, undefined, {
      tokens: [
        {
          token: 'restricted-tok',
          scopes: ['purge:url'],
          tenant: 'tenant1',
        },
      ],
    });

    const allow = api.authenticateAndAuthorize('Bearer restricted-tok', 'purge:url', 'tenant1');
    expect(allow.ok).toBe(true);

    const denyScope = api.authenticateAndAuthorize('Bearer restricted-tok', 'purge:prefix', 'tenant1');
    expect(denyScope.ok).toBe(false);

    const denyTenant = api.authenticateAndAuthorize('Bearer restricted-tok', 'purge:url', 'tenant2');
    expect(denyTenant.ok).toBe(false);
  });
});
