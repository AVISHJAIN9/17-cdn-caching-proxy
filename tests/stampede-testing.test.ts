import { describe, it, expect } from 'vitest';
import { CollapsedForwarder } from '../src/proxy/collapsed-forwarding.js';
import { PassThrough } from 'node:stream';

describe('Feature 133: Stampede testing', () => {
  it('prevents thundering herd on single hot key and multiple keys at cold start', async () => {
    const forwarder = new CollapsedForwarder();
    let upstreamCalls = 0;

    const runHit = (id: string, key: string) =>
      forwarder.fetch({ requestId: id, key }, async () => {
        upstreamCalls++;
        const p = new PassThrough();
        setImmediate(() => {
          p.write('content');
          p.end();
        });
        return {
          statusCode: 200,
          headers: {},
          stream: p,
        };
      });

    // 200 requests for key-A, 100 for key-B simultaneously
    const pA = Array.from({ length: 200 }, (_, i) => runHit(`a-${i}`, 'key-A'));
    const pB = Array.from({ length: 100 }, (_, i) => runHit(`b-${i}`, 'key-B'));

    const [resA, resB] = await Promise.all([Promise.all(pA), Promise.all(pB)]);

    expect(resA.length).toBe(200);
    expect(resB.length).toBe(100);
    expect(upstreamCalls).toBe(2); // Exactly 1 per unique key!
  });
});
