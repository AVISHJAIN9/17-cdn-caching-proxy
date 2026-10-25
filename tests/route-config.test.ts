import { describe, it, expect } from 'vitest';
import { RouteConfigurationManager } from '../src/admin/routes-manager.js';

describe('Feature 113: Route configuration', () => {
  it('supports semantic validation, dry-run, atomic hot-reload, and rollback', () => {
    const manager = new RouteConfigurationManager([
      { id: 'r1', pathPrefix: '/api/', origin: 'origin-api' },
    ]);

    expect(manager.getVersion()).toBe(1);

    // Validation rejection
    const invalid = manager.updateRoutes({
      routes: [{ id: '', origin: '' }],
    });
    expect(invalid.success).toBe(false);

    // Dry-run
    const dryRun = manager.updateRoutes({
      routes: [{ id: 'r2', pathPrefix: '/v2/', origin: 'origin-v2' }],
      dryRun: true,
    });
    expect(dryRun.success).toBe(true);
    expect(manager.getVersion()).toBe(1); // Not applied

    // Real update
    const update = manager.updateRoutes({
      routes: [{ id: 'r2', pathPrefix: '/v2/', origin: 'origin-v2' }],
    });
    expect(update.success).toBe(true);
    expect(manager.getVersion()).toBe(2);

    // Rollback to version 1
    const rolledBack = manager.rollback(1);
    expect(rolledBack).toBe(true);
    expect(manager.getRoutes()[0].id).toBe('r1');
  });
});
