import { describe, it, expect } from 'vitest';
import { RequestInspector } from '../src/admin/request-inspector.js';

describe('Feature 117: Request inspection', () => {
  it('records decisions into bounded ring and redacts sensitive headers', () => {
    const inspector = new RequestInspector(2);

    inspector.recordDecision({
      id: 'req-1',
      timestamp: Date.now(),
      method: 'GET',
      url: 'http://example.com/login',
      tenant: 'default',
      decision: 'BYPASS',
      reason: 'Authorization header present',
      statusCode: 200,
      latencyMs: 15,
      headers: {
        Authorization: 'Bearer super-secret-token',
        Cookie: 'session=12345',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const decisions = inspector.getDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].headers.Authorization).toBe('[REDACTED]');
    expect(decisions[0].headers.Cookie).toBe('[REDACTED]');
    expect(decisions[0].headers['User-Agent']).toBe('Mozilla/5.0');
  });
});
