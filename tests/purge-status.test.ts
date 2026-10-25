import { describe, it, expect } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';

describe('Feature 126: Purge status', () => {
  it('queries job status and lists jobs by tenant', () => {
    const index = new PurgeIndex();
    const queue = new PurgeJobQueue(index);

    const job = queue.submitJob({
      target: { type: 'host', target: 'alpha.com' },
      tenant: 'custA',
    });

    const fetched = queue.getJob(job.id);
    expect(fetched?.state).toBe('completed');

    const list = queue.listJobs({ tenant: 'custA' });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(job.id);
  });
});
