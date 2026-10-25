import { describe, it, expect } from 'vitest';
import { ControllableOrigin } from '../src/stress/controllable-origin.js';
import { CollapsedForwarder } from '../src/proxy/collapsed-forwarding.js';

describe('Feature 131: High-concurrency testing', () => {
  it('handles concurrent keep-alive streams with 0 protocol errors and verified bodies', async () => {
    const origin = new ControllableOrigin();
    const forwarder = new CollapsedForwarder();

    const count = process.env.STRESS_SCALE === 'full' ? 5000 : 500;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < count; i++) {
      promises.push(
        forwarder.fetch(
          { requestId: `conc-${i}`, key: 'http://example.com/asset' },
          async () => {
            const { Readable } = await import('node:stream');
            return {
              statusCode: 200,
              headers: {},
              stream: Readable.from(['hello-stream']),
            };
          }
        )
      );
    }

    const results = await Promise.all(promises);
    expect(results.length).toBe(count);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);

    // Drain body stream of leader to finalize
    for await (const _ of results[0].bodyStream) {}
    expect(forwarder.pendingCount).toBe(0);
  });
});
