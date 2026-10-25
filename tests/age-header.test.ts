import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { FakeClock } from '../src/util/clock.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';

describe('Feature 5: Age Header (src/cache/serve.ts)', () => {
  let originPort: number;
  let proxy: ProxyListener;
  let proxyPort: number;
  let clock: FakeClock;

  beforeEach(async () => {
    resetStats();
    clock = new FakeClock(1700000000000);

    if (!originServer.listening) {
      await new Promise<void>((resolve) => originServer.listen(0, resolve));
    }
    originPort = (originServer.address() as AddressInfo).port;

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      clock,
      cache: {
        enabled: true,
        debugHeaders: true,
      },
    });
    proxyPort = proxy.httpPort!;
  });

  afterEach(async () => {
    await proxy?.stop();
  });

  function request(path: string, headers: Record<string, string> = {}): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${proxyPort}${path}`,
        { headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
            });
          });
        }
      );
      req.on('error', reject);
    });
  }

  it('HIT at age 0 gives "Age: 0"', async () => {
    // 1. Initial request (MISS)
    const r1 = await request('/cc?cc=max-age%3D60');
    expect(r1.headers['x-cache']).toBe('MISS');

    // 2. Immediate request at same instant (HIT)
    const r2 = await request('/cc?cc=max-age%3D60');
    expect(r2.headers['x-cache']).toBe('HIT');
    expect(r2.headers['age']).toBe('0');
  });

  it('after advancing 5s gives "Age: 5"', async () => {
    await request('/cc?cc=max-age%3D60');

    clock.advance(5000);

    const r = await request('/cc?cc=max-age%3D60');
    expect(r.headers['x-cache']).toBe('HIT');
    expect(r.headers['age']).toBe('5');
  });

  it('after advancing 5.9s gives "Age: 5" (floor calculation)', async () => {
    await request('/cc?cc=max-age%3D60');

    clock.advance(5900); // 5.9 seconds

    const r = await request('/cc?cc=max-age%3D60');
    expect(r.headers['x-cache']).toBe('HIT');
    expect(r.headers['age']).toBe('5');
  });

  it('origin Age: 10 plus 3s resident gives "Age: 13"', async () => {
    // Request with origin Age: 10
    const r1 = await request('/cc?cc=max-age%3D60&age=10');
    expect(r1.headers['x-cache']).toBe('MISS');

    // Advance clock 3s
    clock.advance(3000);

    const r2 = await request('/cc?cc=max-age%3D60&age=10');
    expect(r2.headers['x-cache']).toBe('HIT');
    expect(r2.headers['age']).toBe('13');
  });

  it('an origin Age header on a MISS passes through unchanged', async () => {
    const r = await request('/cc?cc=max-age%3D60&age=25');
    expect(r.headers['x-cache']).toBe('MISS');
    expect(r.headers['age']).toBe('25');
  });

  it('a stale origin Age header is not replayed on a HIT (it is replaced with calculated Age)', async () => {
    // Origin sent Age: 10 on MISS
    const r1 = await request('/cc?cc=max-age%3D60&age=10');
    expect(r1.headers['x-cache']).toBe('MISS');
    expect(r1.headers['age']).toBe('10');

    // Advance 4 seconds: calculated Age is 10 + 4 = 14
    clock.advance(4000);

    const r2 = await request('/cc?cc=max-age%3D60&age=10');
    expect(r2.headers['x-cache']).toBe('HIT');
    expect(r2.headers['age']).toBe('14'); // Replaced, not original "10"
  });

  it('Age is a plain non-negative integer string matching /^(0|[1-9][0-9]*)$/ on 200 HITs', async () => {
    await request('/cc?cc=max-age%3D60');

    clock.advance(7250);

    const r = await request('/cc?cc=max-age%3D60');
    expect(r.headers['x-cache']).toBe('HIT');
    const ageHeader = r.headers['age'];
    expect(typeof ageHeader).toBe('string');
    expect(/^(0|[1-9][0-9]*)$/.test(ageHeader!)).toBe(true);
    expect(ageHeader).toBe('7');
  });

  it('Age never exceeds 2147483648 cap', async () => {
    // Huge origin Age header
    const r1 = await request('/cc?cc=max-age%3D2147483648&age=2147483648');
    expect(r1.headers['x-cache']).toBe('MISS');

    // Advance clock
    clock.advance(1000000000);

    const r2 = await request('/cc?cc=max-age%3D2147483648&age=2147483648');
    // Stale because initial age was 2147483648 >= lifetime 2147483648, so it was already_stale
    expect(r2.headers['x-cache-reason']).toBe('already_stale');
  });

  it('never exposes keyString or keyHash in response headers', async () => {
    const r1 = await request('/cc?cc=max-age%3D60');
    const r2 = await request('/cc?cc=max-age%3D60');

    for (const res of [r1, r2]) {
      for (const headerName of Object.keys(res.headers)) {
        expect(headerName.toLowerCase()).not.toContain('keyhash');
        expect(headerName.toLowerCase()).not.toContain('keystring');
      }
      expect(JSON.stringify(res.headers)).not.toContain('fake-');
    }
  });
});
