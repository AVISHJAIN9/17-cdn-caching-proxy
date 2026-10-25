import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';

describe('Feature 125: Async purge jobs', () => {
  it('submits, executes, and checks progress of async purge jobs', () => {
    const index = new PurgeIndex();
    const queue = new PurgeJobQueue(index);

    const job = queue.submitJob({
      target: { type: 'prefix', target: '/api/' },
    });

    expect(job.id).toBeDefined();
    expect(job.state).toBe('completed');
  });
});
