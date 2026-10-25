import { describe, it, expect } from 'vitest';
import { CacheWarmManager } from '../src/warm/warm-prefetch.js';

describe('Feature 129: Cache warm API', () => {
  it('blocks loopback and private IP addresses under SSRF protection', async () => {
    const manager = new CacheWarmManager();
    const job = await manager.submitWarmJob({
      urls: ['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest/meta-data'],
    });

    expect(job.state).toBe('completed');
    expect(job.results.length).toBe(2);
    expect(job.results[0].status).toBe('failed');
    expect(job.results[0].reason).toContain('SSRF');
  });

  it('warms valid external URLs and attaches x-cdn-warm header', async () => {
    const manager = new CacheWarmManager();
    const sentHeaders: Record<string, string> = {};

    const job = await manager.submitWarmJob(
      {
        urls: ['https://cdn.example.com/asset.js', 'https://cdn.example.com/nocache'],
      },
      async (url, headers) => {
        Object.assign(sentHeaders, headers);
        if (url.includes('nocache')) {
          return { statusCode: 200, cacheable: false };
        }
        return { statusCode: 200, cacheable: true };
      }
    );

    expect(sentHeaders['x-cdn-warm']).toBe('1');
    expect(job.results[0].status).toBe('warmed');
    expect(job.results[1].status).toBe('skipped-uncacheable');
  });
});
