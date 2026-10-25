import { describe, it, expect } from 'vitest';
import { renderDashboardHtml } from '../src/admin/dashboard-html.js';

describe('Feature 105 & 115: Dashboard UI and Purge interface', () => {
  it('renders self-contained HTML with zero external script or font references', () => {
    const html = renderDashboardHtml('test-nonce');

    // Must not have external scripts or stylesheets
    expect(html).not.toMatch(/src=["']https?:\/\//i);
    expect(html).not.toMatch(/href=["']https?:\/\//i);

    // Contains inline SVG charts
    expect(html).toContain('<svg class="chart"');

    // Contains Purge and Inspect navigation buttons
    expect(html).toContain('data-tab="purge"');
    expect(html).toContain('data-tab="inspect"');
  });
});
