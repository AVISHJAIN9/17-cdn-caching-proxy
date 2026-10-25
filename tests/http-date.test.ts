import { describe, it, expect } from 'vitest';
import { parseHttpDate, resolveTwoDigitYear } from '../src/cache/http-date.js';
import { freshnessLifetimeMs } from '../src/cache/lifetime.js';
import { parseCacheControl } from '../src/cache/cache-control.js';

describe('Feature 3: HTTP date parser and Expires handling (src/cache/http-date.ts)', () => {
  describe('parseHttpDate format support', () => {
    it('parses IMF-fixdate format (e.g. Sun, 06 Nov 1994 08:49:37 GMT)', () => {
      const ms = parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT');
      expect(ms).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
    });

    it('parses obsolete RFC 850 format (e.g. Sunday, 06-Nov-94 08:49:37 GMT)', () => {
      // 94 with reference year 2026 resolves to 1994
      const ms = parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT', 2026);
      expect(ms).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
    });

    it('parses ANSI C asctime format with two-digit day (e.g. Sun Nov 16 08:49:37 1994)', () => {
      const ms = parseHttpDate('Sun Nov 16 08:49:37 1994');
      expect(ms).toBe(Date.UTC(1994, 10, 16, 8, 49, 37));
    });

    it('parses ANSI C asctime format with single-digit space-padded day (e.g. Sun Nov  6 08:49:37 1994)', () => {
      const ms = parseHttpDate('Sun Nov  6 08:49:37 1994');
      expect(ms).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
    });
  });

  describe('Two-digit year rollover rule (RFC 9110)', () => {
    it('interprets year > 50 years in future as most recent past year', () => {
      const ref = 2026;
      // 94 -> 2094 is 68 years in future (>50) -> 1994
      expect(resolveTwoDigitYear(94, ref)).toBe(1994);
      // 77 -> 2077 is 51 years in future (>50) -> 1977
      expect(resolveTwoDigitYear(77, ref)).toBe(1977);
      // 76 -> 2076 is 50 years in future (<=50) -> 2076
      expect(resolveTwoDigitYear(76, ref)).toBe(2076);
      // 30 -> 2030 is 4 years in future -> 2030
      expect(resolveTwoDigitYear(30, ref)).toBe(2030);
      // 26 -> 2026 is current year -> 2026
      expect(resolveTwoDigitYear(26, ref)).toBe(2026);
    });
  });

  describe('Rejection of invalid date strings (20+ invalid cases)', () => {
    const invalidStrings = [
      '0',
      '-1',
      '',
      '   ',
      'invalid-string',
      'Sun, 06 Nov 1994 08:49:37', // missing GMT
      'Sun, 06 Nov 1994 08:49:37 UTC', // UTC instead of GMT
      'Sun, 06 Nov 1994 08:49:37 +0000', // numeric timezone
      'Sun, 06 Nov 1994 08:49:37 -0500', // numeric timezone
      'Sun, 30 Feb 1994 08:49:37 GMT', // impossible date (Feb 30)
      'Sun, 29 Feb 1993 08:49:37 GMT', // impossible leap day in non-leap year (1993)
      'Sun, 31 Apr 1994 08:49:37 GMT', // impossible date (Apr 31)
      'Sun, 31 Jun 1994 08:49:37 GMT', // impossible date (Jun 31)
      'Sun, 31 Sep 1994 08:49:37 GMT', // impossible date (Sep 31)
      'Sun, 31 Nov 1994 08:49:37 GMT', // impossible date (Nov 31)
      'Sun, 06 Nov 1994 25:00:00 GMT', // hour 25 out of range
      'Sun, 06 Nov 1994 08:60:00 GMT', // minute 60 out of range
      'Sun, 06 Nov 1994 08:49:61 GMT', // second 61 out of range
      'Sun, 06 Nov 1994 08:49:37 GMT extra trailing', // trailing garbage
      'leading garbage Sun, 06 Nov 1994 08:49:37 GMT', // leading garbage
      'Sunday, 06-Nov-94 08:49:37', // RFC 850 missing GMT
      'Sunday, 30-Feb-94 08:49:37 GMT', // RFC 850 Feb 30
      'Sun Nov 32 08:49:37 1994', // asctime day 32
      '2026-10-23T01:00:00Z', // ISO 8601 (not an HTTP-date)
    ];

    it(`rejects all 20+ invalid strings (tested ${invalidStrings.length})`, () => {
      expect(invalidStrings.length).toBeGreaterThanOrEqual(20);
      for (const str of invalidStrings) {
        expect(parseHttpDate(str), `Expected null for invalid date: "${str}"`).toBeNull();
      }
    });
  });

  describe('Expires semantics in freshnessLifetimeMs', () => {
    it('calculates freshness lifetime from valid Expires and Date', () => {
      const cc = parseCacheControl('public');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0); // 12:00:00
      const expiresStr = 'Thu, 01 Jan 2026 12:05:00 GMT'; // 12:05:00 (+300s = 300,000ms)
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: expiresStr, dateMs });
      expect(res).toEqual({ lifetimeMs: 300000, source: 'expires' });
    });

    it('treats Expires in the past relative to Date as lifetime 0 (already expired)', () => {
      const cc = parseCacheControl('public');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const expiresStr = 'Thu, 01 Jan 2026 11:55:00 GMT'; // 5 minutes in the past
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: expiresStr, dateMs });
      expect(res).toEqual({ lifetimeMs: 0, source: 'expires' });
    });

    it('treats invalid Expires ("0") as already expired (lifetime 0)', () => {
      const cc = parseCacheControl('public');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: '0', dateMs });
      expect(res).toEqual({ lifetimeMs: 0, source: 'expires' });
    });

    it('treats invalid Expires ("-1") as already expired (lifetime 0)', () => {
      const cc = parseCacheControl('public');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: '-1', dateMs });
      expect(res).toEqual({ lifetimeMs: 0, source: 'expires' });
    });

    it('ignores Expires when max-age is present', () => {
      const cc = parseCacheControl('max-age=60');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const expiresStr = 'Thu, 01 Jan 2026 12:05:00 GMT';
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: expiresStr, dateMs });
      expect(res).toEqual({ lifetimeMs: 60000, source: 'max-age' });
    });

    it('ignores Expires when max-age is invalid', () => {
      const cc = parseCacheControl('max-age=bad');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const expiresStr = 'Thu, 01 Jan 2026 12:05:00 GMT';
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: expiresStr, dateMs });
      expect(res).toEqual({ lifetimeMs: 0, source: 'invalid' });
    });

    it('ignores Expires when s-maxage is present', () => {
      const cc = parseCacheControl('s-maxage=180');
      const dateMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const expiresStr = 'Thu, 01 Jan 2026 12:05:00 GMT';
      const res = freshnessLifetimeMs({ cacheControl: cc, expiresHeader: expiresStr, dateMs });
      expect(res).toEqual({ lifetimeMs: 180000, source: 's-maxage' });
    });
  });
});
