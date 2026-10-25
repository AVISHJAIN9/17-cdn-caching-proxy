import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { FakeClock } from '../src/util/clock.js';
import { currentAgeMs, isFresh, parseAgeHeader, parseResponseDate, AgeMetadata } from '../src/cache/freshness.js';
import { checkResponseStorableFromHeaders } from '../src/cache/policy.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';

describe('Feature 4: RFC 9111 Freshness Calculation and Policy (src/cache/freshness.ts & policy.ts)', () => {
  describe('Unit tests & Table-driven freshness math (at least 30 rows)', () => {
    interface FreshnessTableRow {
      id: number;
      description: string;
      requestTimeMs: number;
      responseTimeMs: number;
      dateValueMs: number;
      ageValueSeconds: number;
      freshnessLifetimeMs: number;
      nowMs: number;
      expectedAgeMs: number;
      expectedFresh: boolean;
    }

    const t0 = 1_000_000_000; // baseline timestamp

    const tableRows: FreshnessTableRow[] = [
      // 1-4: Lifetime 60s at age 0/59/60/61 (apparent age 0, delay 0, resident time varies)
      {
        id: 1,
        description: 'lifetime 60s at age 0 (fresh)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 0,
        expectedFresh: true,
      },
      {
        id: 2,
        description: 'lifetime 60s at age 59s (fresh)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 59000,
        expectedAgeMs: 59000,
        expectedFresh: true,
      },
      {
        id: 3,
        description: 'lifetime 60s at age 60s (boundary: age == lifetime is STALE)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 60000,
        expectedAgeMs: 60000,
        expectedFresh: false,
      },
      {
        id: 4,
        description: 'lifetime 60s at age 61s (stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 61000,
        expectedAgeMs: 61000,
        expectedFresh: false,
      },

      // 5-8: Origin Age: 30s with max-age=60 is fresh for 30 more seconds
      {
        id: 5,
        description: 'origin Age: 30s with max-age=60 at resident time 0s (age=30s, fresh)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 30,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 30000,
        expectedFresh: true,
      },
      {
        id: 6,
        description: 'origin Age: 30s with max-age=60 at resident time 29s (age=59s, fresh)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 30,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 29000,
        expectedAgeMs: 59000,
        expectedFresh: true,
      },
      {
        id: 7,
        description: 'origin Age: 30s with max-age=60 at resident time 30s (age=60s, boundary stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 30,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 30000,
        expectedAgeMs: 60000,
        expectedFresh: false,
      },
      {
        id: 8,
        description: 'origin Age: 30s with max-age=60 at resident time 31s (age=61s, stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 30,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 31000,
        expectedAgeMs: 61000,
        expectedFresh: false,
      },

      // 9-11: Response delay of 2s adds to age (responseTime - requestTime = 2000ms)
      {
        id: 9,
        description: 'response delay 2s at arrival (initial age = 2s)',
        requestTimeMs: t0,
        responseTimeMs: t0 + 2000,
        dateValueMs: t0 + 2000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 2000,
        expectedAgeMs: 2000,
        expectedFresh: true,
      },
      {
        id: 10,
        description: 'response delay 2s with origin Age 5s (corrected_age_value = 5000 + 2000 = 7s)',
        requestTimeMs: t0,
        responseTimeMs: t0 + 2000,
        dateValueMs: t0 + 2000,
        ageValueSeconds: 5,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 2000,
        expectedAgeMs: 7000,
        expectedFresh: true,
      },
      {
        id: 11,
        description: 'response delay 2s with origin Age 5s plus resident time 10s (age = 17s)',
        requestTimeMs: t0,
        responseTimeMs: t0 + 2000,
        dateValueMs: t0 + 2000,
        ageValueSeconds: 5,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 12000,
        expectedAgeMs: 17000,
        expectedFresh: true,
      },

      // 12-14: Date 10s in the past (apparent_age = 10s) with max-age=60 leaves 50s
      {
        id: 12,
        description: 'date 10s in past (apparent_age 10s) at arrival leaves 50s',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 10000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 10000,
        expectedFresh: true,
      },
      {
        id: 13,
        description: 'date 10s in past after 49s resident time (age = 59s, fresh)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 10000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 49000,
        expectedAgeMs: 59000,
        expectedFresh: true,
      },
      {
        id: 14,
        description: 'date 10s in past after 50s resident time (age = 60s, stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 10000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 50000,
        expectedAgeMs: 60000,
        expectedFresh: false,
      },

      // 15-17: Date in the future (apparent_age clamps to 0)
      {
        id: 15,
        description: 'date 20s in future (apparent_age clamps to 0) at arrival',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 + 20000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 0,
        expectedFresh: true,
      },
      {
        id: 16,
        description: 'date 20s in future with origin Age 5s (corrected initial age is 5s)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 + 20000,
        ageValueSeconds: 5,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 5000,
        expectedFresh: true,
      },
      {
        id: 17,
        description: 'date in future after resident time 60s (age = 60s, stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 + 10000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 60000,
        expectedAgeMs: 60000,
        expectedFresh: false,
      },

      // 18-20: Missing Date (dateValueMs equals responseTimeMs)
      {
        id: 18,
        description: 'missing date header (dateValue == responseTime)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 30000,
        nowMs: t0 + 10000,
        expectedAgeMs: 10000,
        expectedFresh: true,
      },
      {
        id: 19,
        description: 'missing date with 1s response delay (age = 1s + resident)',
        requestTimeMs: t0,
        responseTimeMs: t0 + 1000,
        dateValueMs: t0 + 1000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 30000,
        nowMs: t0 + 11000,
        expectedAgeMs: 11000,
        expectedFresh: true,
      },
      {
        id: 20,
        description: 'missing date reaching boundary (age = 30s == lifetime 30s, stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 30000,
        nowMs: t0 + 30000,
        expectedAgeMs: 30000,
        expectedFresh: false,
      },

      // 21-23: Clock moving backwards (resident_time < 0 clamped to 0)
      {
        id: 21,
        description: 'clock backwards by 5s (now < responseTime): resident_time clamped to 0',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 10,
        freshnessLifetimeMs: 60000,
        nowMs: t0 - 5000,
        expectedAgeMs: 10000,
        expectedFresh: true,
      },
      {
        id: 22,
        description: 'clock backwards by 1 hour: age does not become negative, stays at initial age',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 5,
        freshnessLifetimeMs: 60000,
        nowMs: t0 - 3600000,
        expectedAgeMs: 5000,
        expectedFresh: true,
      },
      {
        id: 23,
        description: 'clock backwards with apparent age 15s: age is 15s',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 15000,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 - 5000,
        expectedAgeMs: 15000,
        expectedFresh: true,
      },

      // 24-27: Apparent age vs corrected age value comparison (max takes the higher)
      {
        id: 24,
        description: 'apparent age (20s) > corrected age (10s): takes 20s',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 20000,
        ageValueSeconds: 10,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 20000,
        expectedFresh: true,
      },
      {
        id: 25,
        description: 'corrected age (25s) > apparent age (15s): takes 25s',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 15000,
        ageValueSeconds: 25,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 25000,
        expectedFresh: true,
      },
      {
        id: 26,
        description: 'corrected age (50s) with 10s resident time (age = 60s == lifetime 60s, stale)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 50,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 10000,
        expectedAgeMs: 60000,
        expectedFresh: false,
      },
      {
        id: 27,
        description: 'corrected age equals apparent age: both 30s',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0 - 30000,
        ageValueSeconds: 30,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 30000,
        expectedFresh: true,
      },

      // 28-32: Huge values, zero lifetime, boundary tests
      {
        id: 28,
        description: 'zero lifetime is always stale even at age 0',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 0,
        nowMs: t0,
        expectedAgeMs: 0,
        expectedFresh: false,
      },
      {
        id: 29,
        description: 'age larger than lifetime is stale',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 70,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 70000,
        expectedFresh: false,
      },
      {
        id: 30,
        description: 'huge age value (capped at 2^31 seconds = 2147483648000 ms)',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 2147483648,
        freshnessLifetimeMs: 60000,
        nowMs: t0,
        expectedAgeMs: 2147483648000,
        expectedFresh: false,
      },
      {
        id: 31,
        description: 'sub-second precision: lifetime 60000ms at age 59999ms is fresh',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 59999,
        expectedAgeMs: 59999,
        expectedFresh: true,
      },
      {
        id: 32,
        description: 'sub-second precision: lifetime 60000ms at age 60001ms is stale',
        requestTimeMs: t0,
        responseTimeMs: t0,
        dateValueMs: t0,
        ageValueSeconds: 0,
        freshnessLifetimeMs: 60000,
        nowMs: t0 + 60001,
        expectedAgeMs: 60001,
        expectedFresh: false,
      },
    ];

    it(`runs at least 30 table-driven test cases (actual: ${tableRows.length})`, () => {
      expect(tableRows.length).toBeGreaterThanOrEqual(30);
      for (const row of tableRows) {
        const metadata: AgeMetadata = {
          requestTimeMs: row.requestTimeMs,
          responseTimeMs: row.responseTimeMs,
          dateValueMs: row.dateValueMs,
          ageValueSeconds: row.ageValueSeconds,
        };

        const age = currentAgeMs(metadata, row.nowMs);
        expect(age, `Age failed on row ${row.id}: ${row.description}`).toBe(row.expectedAgeMs);

        const fresh = isFresh(
          { ...metadata, freshnessLifetimeMs: row.freshnessLifetimeMs },
          row.nowMs
        );
        expect(fresh, `isFresh failed on row ${row.id}: ${row.description}`).toBe(row.expectedFresh);
      }
    });

    it('parses origin Age header correctly with invalid/multiple values', () => {
      // Invalid / missing
      expect(parseAgeHeader(undefined)).toBe(0);
      expect(parseAgeHeader('')).toBe(0);
      expect(parseAgeHeader('abc')).toBe(0);
      expect(parseAgeHeader('-5')).toBe(0);
      expect(parseAgeHeader('+10')).toBe(0);

      // Single valid
      expect(parseAgeHeader('30')).toBe(30);

      // Huge value capped at 2147483648
      expect(parseAgeHeader('99999999999')).toBe(2147483648);

      // Two Age headers / comma-separated values: pick the largest
      expect(parseAgeHeader(['10', '25'])).toBe(25);
      expect(parseAgeHeader('10, 50, 30')).toBe(50);
      expect(parseAgeHeader(['40', 'invalid', '15'])).toBe(40);
    });

    it('parses response Date header correctly, falling back to responseTimeMs', () => {
      const responseTime = 1700000000000;
      // Valid Date
      const parsed = parseResponseDate('Sun, 06 Nov 1994 08:49:37 GMT', responseTime);
      expect(parsed).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));

      // Missing Date
      expect(parseResponseDate(undefined, responseTime)).toBe(responseTime);

      // Invalid Date
      expect(parseResponseDate('invalid-date', responseTime)).toBe(responseTime);
    });

    it('storable policy refuses to store when initial age >= lifetime (already_stale)', () => {
      const t = 1000000;
      // Origin says max-age=60 but Age: 70 -> already stale at arrival
      const check = checkResponseStorableFromHeaders({
        statusCode: 200,
        headers: {
          'cache-control': 'max-age=60',
          age: '70',
        },
        requestTimeMs: t,
        responseTimeMs: t,
      });
      expect(check.storable).toBe(false);
      expect(check.reason).toBe('already_stale');
    });
  });

  describe('Integration tests with live sockets and FakeClock', () => {
    let originPort: number;
    let proxyPort: number;
    let proxy: any;
    let clock: FakeClock;

    beforeEach(async () => {
      resetStats();
      clock = new FakeClock(1700000000000);

      // Start demo origin server if not listening
      if (!originServer.listening) {
        await new Promise<void>((resolve) => originServer.listen(0, resolve));
      }
      originPort = (originServer.address() as AddressInfo).port;

      // Start proxy pointing to demo origin
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

    it('/cc?cc=max-age%3D60 is MISS then HIT and a FakeClock advance of 61s makes it MISS', async () => {
      // 1. First request -> MISS
      const r1 = await request('/cc?cc=max-age%3D60');
      expect(r1.headers['x-cache']).toBe('MISS');
      const counter1 = r1.body;

      // 2. Second request -> HIT with same body
      const r2 = await request('/cc?cc=max-age%3D60');
      expect(r2.headers['x-cache']).toBe('HIT');
      expect(r2.body).toBe(counter1);

      // 3. Advance clock past 60s
      clock.advance(61000);

      // 4. Third request -> MISS with new counter
      const r3 = await request('/cc?cc=max-age%3D60');
      expect(r3.headers['x-cache']).toBe('MISS');
      expect(r3.body).not.toBe(counter1);
    });

    it('/cc with no cache headers is never stored (origin counter increases every time, X-Cache-Reason: no_freshness_info)', async () => {
      const r1 = await request('/cc');
      expect(r1.headers['x-cache']).toBe('MISS');
      expect(r1.headers['x-cache-reason']).toBe('no_freshness_info');

      const r2 = await request('/cc');
      expect(r2.headers['x-cache']).toBe('MISS');
      expect(r2.headers['x-cache-reason']).toBe('no_freshness_info');
      expect(r2.body).not.toBe(r1.body);
    });

    it('no-store, private, and no-cache responses are never stored', async () => {
      // no-store
      const ns1 = await request('/cc?cc=no-store');
      expect(ns1.headers['x-cache']).toBe('MISS');
      expect(ns1.headers['x-cache-reason']).toBe('no_store');
      const ns2 = await request('/cc?cc=no-store');
      expect(ns2.headers['x-cache']).toBe('MISS');
      expect(ns2.body).not.toBe(ns1.body);

      // private
      const p1 = await request('/cc?cc=private%2Cmax-age%3D60');
      expect(p1.headers['x-cache']).toBe('MISS');
      expect(p1.headers['x-cache-reason']).toBe('private');
      const p2 = await request('/cc?cc=private%2Cmax-age%3D60');
      expect(p2.headers['x-cache']).toBe('MISS');
      expect(p2.body).not.toBe(p1.body);

      // no-cache
      const nc1 = await request('/cc?cc=no-cache%2Cmax-age%3D60');
      expect(nc1.headers['x-cache']).toBe('MISS');
      expect(nc1.headers['x-cache-reason']).toBe('no_cache');
      const nc2 = await request('/cc?cc=no-cache%2Cmax-age%3D60');
      expect(nc2.headers['x-cache']).toBe('MISS');
      expect(nc2.body).not.toBe(nc1.body);
    });

    it('s-maxage=100,max-age=1 stays fresh past 1s', async () => {
      const r1 = await request('/cc?cc=s-maxage%3D100%2Cmax-age%3D1');
      expect(r1.headers['x-cache']).toBe('MISS');

      // Advance clock 2 seconds (past max-age=1s, but well within s-maxage=100s)
      clock.advance(2000);

      const r2 = await request('/cc?cc=s-maxage%3D100%2Cmax-age%3D1');
      expect(r2.headers['x-cache']).toBe('HIT');
      expect(r2.body).toBe(r1.body);
    });

    it('/cc-multi (two Cache-Control lines, one with no-store) is never stored', async () => {
      const r1 = await request('/cc-multi');
      expect(r1.headers['x-cache']).toBe('MISS');
      expect(r1.headers['x-cache-reason']).toBe('no_store');

      const r2 = await request('/cc-multi');
      expect(r2.headers['x-cache']).toBe('MISS');
      expect(r2.headers['x-cache-reason']).toBe('no_store');
      expect(r2.body).not.toBe(r1.body);
    });

    it('Expires-only response is cached until the Expires time', async () => {
      // Set Expires 10 seconds into the future of clock.now()
      const futureDate = new Date(clock.now() + 10000).toUTCString();
      const encodedExpires = encodeURIComponent(futureDate);

      // Using date=none suppresses the origin's automatic Date header so proxy uses its clock
      const r1 = await request(`/cc?date=none&expires=${encodedExpires}`);
      expect(r1.headers['x-cache']).toBe('MISS');

      // Immediate second request -> HIT
      const r2 = await request(`/cc?date=none&expires=${encodedExpires}`);
      expect(r2.headers['x-cache']).toBe('HIT');
      expect(r2.body).toBe(r1.body);

      // Advance clock past Expires (11 seconds)
      clock.advance(11000);

      // Third request -> MISS
      const r3 = await request(`/cc?date=none&expires=${encodedExpires}`);
      expect(r3.headers['x-cache']).toBe('MISS');
      expect(r3.body).not.toBe(r1.body);
    });
  });
});
