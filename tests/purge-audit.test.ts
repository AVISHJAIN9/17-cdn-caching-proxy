import { describe, it, expect } from 'vitest';
import { PurgeAuditTrail } from '../src/purge/audit.js';

describe('Feature 128: Purge audit trail', () => {
  it('records tamper-evident SHA-256 chained audit entries and verifies integrity', () => {
    const audit = new PurgeAuditTrail();
    audit.record({
      actor: 'admin1',
      tenant: 'tenantX',
      action: 'purge:url',
      scope: 'url',
      target: 'http://example.com/item',
      outcome: 'success',
    });

    audit.record({
      actor: 'admin2',
      tenant: 'tenantX',
      action: 'purge:tag',
      scope: 'tag',
      target: 'images',
      outcome: 'success',
    });

    expect(audit.verify().valid).toBe(true);

    const q = audit.query({ tenant: 'tenantX' });
    expect(q.length).toBe(2);
  });
});
