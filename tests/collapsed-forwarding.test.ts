import { describe, it, expect } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import { CollapsedForwarder } from '../src/proxy/collapsed-forwarding.js';

describe('Feature 52: Collapsed Forwarding', () => {
  it('collapses 500 concurrent identical misses into exactly 1 upstream request with identical bodies', async () => {
    const forwarder = new CollapsedForwarder();
    let upstreamFetches = 0;
    const bodyContent = 'Hello Collapsed World! ' + 'x'.repeat(1024);

    const runFetch = (id: string) => {
      return forwarder.fetch(
        {
          requestId: `req-${id}`,
          key: 'https://example.com/api/heavy-data',
        },
        async () => {
          upstreamFetches++;
          const stream = new PassThrough();
          setTimeout(() => {
            stream.write(Buffer.from(bodyContent));
            stream.end();
          }, 10);

          return {
            statusCode: 200,
            statusMessage: 'OK',
            headers: {
              'content-type': 'text/plain',
              'cache-control': 'public, max-age=3600',
            },
            stream,
          };
        }
      );
    };

    const promises = Array.from({ length: 500 }, (_, i) => runFetch(String(i)));
    const results = await Promise.all(promises);

    expect(upstreamFetches).toBe(1);

    const leader = results.find((r) => r.role === 'leader');
    expect(leader).toBeDefined();

    const followers = results.filter((r) => r.role === 'follower');
    expect(followers.length).toBe(499);

    // Read bodies of leader and a sample of followers
    const readStream = async (stream: Readable): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    };

    const leaderBody = await readStream(leader!.bodyStream);
    expect(leaderBody).toBe(bodyContent);

    const followerBody = await readStream(followers[0].bodyStream);
    expect(followerBody).toBe(bodyContent);

    // Pending flight map must be clean
    expect(forwarder.pendingCount).toBe(0);
  });

  it('promotes oldest follower when leader aborts or fails before headers', async () => {
    const forwarder = new CollapsedForwarder({ maxPromotions: 3 });
    let attempts = 0;

    const run = (id: string) =>
      forwarder.fetch(
        {
          requestId: `req-${id}`,
          key: 'https://example.com/failover',
        },
        async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('Simulated upstream failure on attempt 1');
          }
          const stream = new PassThrough();
          setImmediate(() => {
            stream.write('Recovered by promoted follower');
            stream.end();
          });
          return {
            statusCode: 200,
            headers: {},
            stream,
          };
        }
      );

    const p1 = run('1');
    const p2 = run('2');

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(attempts).toBe(2);
    expect(r2.status).toBe('fulfilled');
    if (r2.status === 'fulfilled') {
      for await (const _ of r2.value.bodyStream) {}
    }
    expect(forwarder.pendingCount).toBe(0);
  });

  it('fans out upstream 500 error to followers', async () => {
    const forwarder = new CollapsedForwarder();
    let upstreamCalls = 0;

    const run = (id: string) =>
      forwarder.fetch(
        {
          requestId: `req-${id}`,
          key: 'https://example.com/500-error',
        },
        async () => {
          upstreamCalls++;
          const stream = new PassThrough();
          setImmediate(() => {
            stream.write('Server Error');
            stream.end();
          });
          return {
            statusCode: 500,
            headers: { 'cache-control': 'no-store' },
            stream,
          };
        }
      );

    const [res1, res2] = await Promise.all([run('1'), run('2')]);
    expect(upstreamCalls).toBe(1);
    expect(res1.statusCode).toBe(500);
    expect(res2.statusCode).toBe(500);

    for await (const _ of res1.bodyStream) {}
    for await (const _ of res2.bodyStream) {}
    expect(forwarder.pendingCount).toBe(0);
  });

  it('does not collapse requests with different Vary variants', async () => {
    const forwarder = new CollapsedForwarder();
    let fetches = 0;

    const makeReq = async (varyKey: string) => {
      const res = await forwarder.fetch(
        {
          requestId: `req-${varyKey}`,
          key: 'https://example.com/vary-test',
          varyKey,
        },
        async () => {
          fetches++;
          const stream = new PassThrough();
          setImmediate(() => {
            stream.write(`Body for ${varyKey}`);
            stream.end();
          });
          return {
            statusCode: 200,
            headers: { 'cache-control': 'public, max-age=60' },
            stream,
          };
        }
      );
      for await (const _ of res.bodyStream) {}
    };

    await Promise.all([makeReq('gzip'), makeReq('br')]);
    expect(fetches).toBe(2);
    expect(forwarder.pendingCount).toBe(0);
  });

  it('does not collapse incompatible Range requests', async () => {
    const forwarder = new CollapsedForwarder();
    let fetches = 0;

    const makeRangeReq = async (rangeHeader: string) => {
      const res = await forwarder.fetch(
        {
          requestId: `req-${rangeHeader}`,
          key: 'https://example.com/media.mp4',
          rangeHeader,
        },
        async () => {
          fetches++;
          const stream = new PassThrough();
          setImmediate(() => {
            stream.write(`Bytes for ${rangeHeader}`);
            stream.end();
          });
          return {
            statusCode: 206,
            headers: { 'cache-control': 'public, max-age=60' },
            stream,
          };
        }
      );
      for await (const _ of res.bodyStream) {}
    };

    await Promise.all([makeRangeReq('bytes=0-100'), makeRangeReq('bytes=500-600')]);
    expect(fetches).toBe(2);
    expect(forwarder.pendingCount).toBe(0);
  });

  it('verifies pending-map size returns to 0 after completion', async () => {
    const forwarder = new CollapsedForwarder();
    const res = await forwarder.fetch(
      {
        requestId: 'clean-check',
        key: 'https://example.com/clean',
      },
      async () => {
        const stream = new PassThrough();
        stream.end('done');
        return {
          statusCode: 200,
          headers: {},
          stream,
        };
      }
    );

    for await (const _ of res.bodyStream) {}
    expect(forwarder.pendingCount).toBe(0);
  });
});
