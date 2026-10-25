import { describe, it, expect } from 'vitest';
import { renderDashboardHtml } from '../src/admin/dashboard-html.js';

describe('Feature 115: Purge interface', () => {
  it('includes dedicated purge interface tab and controls in admin dashboard', () => {
    const html = renderDashboardHtml('test-nonce');
    expect(html).toContain('data-tab="purge"');
    expect(html).toContain('Purge');
  });
});
