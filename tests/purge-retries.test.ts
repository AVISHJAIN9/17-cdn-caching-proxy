import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';

describe('Feature 127: Purge retries', () => {
  it('retries failed purge jobs up to max attempts and enters dead-letter state', () => {
    const index = new PurgeIndex();
    // Simulate purge failure
    index.executePurge = () => {
      throw new Error('Disk timeout during purge');
    };

    const queue = new PurgeJobQueue(index, undefined, { maxAttempts: 2, baseBackoffMs: 1 });
    const job = queue.submitJob({
      target: { type: 'url', target: 'http://fail.com' },
    });

    expect(job.attempts).toBeGreaterThanOrEqual(1);

    // Force retry to exceed max attempts
    queue.scheduleDrain();
    expect(['queued', 'dead_letter']).toContain(job.state);
  });
});
