import { describe, it, expect } from 'vitest';
import { parseCacheControl, ParsedCacheControl } from '../src/cache/cache-control.js';

describe('Feature 1: Cache-Control parsing (src/cache/cache-control.ts)', () => {
  interface TestCase {
    name: string;
    input: string | string[] | undefined;
    expected: Partial<ParsedCacheControl>;
  }

  const tableCases: TestCase[] = [
    // 1-10: Basic individual directives
    { name: 'no-store directive', input: 'no-store', expected: { noStore: true } },
    { name: 'no-cache directive (unqualified)', input: 'no-cache', expected: { noCache: true } },
    {
      name: 'no-cache directive with fields',
      input: 'no-cache="Set-Cookie, X-Custom"',
      expected: { noCache: true, noCacheFields: ['set-cookie', 'x-custom'] },
    },
    { name: 'private directive (unqualified)', input: 'private', expected: { private: true } },
    {
      name: 'private directive with fields',
      input: 'private="User-Token"',
      expected: { private: true, privateFields: ['user-token'] },
    },
    { name: 'public directive', input: 'public', expected: { public: true } },
    { name: 'must-revalidate directive', input: 'must-revalidate', expected: { mustRevalidate: true } },
    { name: 'proxy-revalidate directive', input: 'proxy-revalidate', expected: { proxyRevalidate: true } },
    { name: 'no-transform directive', input: 'no-transform', expected: { noTransform: true } },
    { name: 'immutable directive', input: 'immutable', expected: { immutable: true } },

    // 11-20: Delta-seconds directives & case sensitivity
    { name: 'only-if-cached directive', input: 'only-if-cached', expected: { onlyIfCached: true } },
    { name: 'max-age=60', input: 'max-age=60', expected: { maxAge: 60 } },
    { name: 'mixed case Max-Age=60', input: 'Max-Age=60', expected: { maxAge: 60 } },
    { name: 'uppercase MAX-AGE=3600', input: 'MAX-AGE=3600', expected: { maxAge: 3600 } },
    { name: 's-maxage=120', input: 's-maxage=120', expected: { sMaxAge: 120 } },
    { name: 'mixed case S-MaxAge=120', input: 'S-MaxAge=120', expected: { sMaxAge: 120 } },
    { name: 'stale-while-revalidate=30', input: 'stale-while-revalidate=30', expected: { staleWhileRevalidate: 30 } },
    { name: 'stale-if-error=600', input: 'stale-if-error=600', expected: { staleIfError: 600 } },
    { name: 'min-fresh=15', input: 'min-fresh=15', expected: { minFresh: 15 } },
    { name: 'max-stale with no value', input: 'max-stale', expected: { maxStale: true } },

    // 21-30: Formatting, spaces, quotes, commas
    { name: 'max-stale with delta-seconds', input: 'max-stale=45', expected: { maxStale: 45 } },
    { name: 'spaces around commas and equals signs', input: '  max-age = 60 , no-store  ', expected: { maxAge: 60, noStore: true } },
    { name: 'quoted value without commas', input: 'max-age="120"', expected: { maxAge: 120 } },
    { name: 'quoted value containing commas inside quotes', input: 'community="UCI, Irvine", max-age=60', expected: { maxAge: 60, extensions: { community: 'UCI, Irvine' } } },
    { name: 'escaped quotes inside quoted value', input: 'community="hello \\"world\\"", public', expected: { public: true, extensions: { community: 'hello "world"' } } },
    { name: 'empty header string', input: '', expected: { noStore: false, invalid: [] } },
    { name: 'whitespace only header string', input: '   ', expected: { noStore: false, invalid: [] } },
    { name: 'undefined input', input: undefined, expected: { noStore: false, invalid: [] } },
    { name: 'header made only of commas', input: ',,,,  , ,', expected: { noStore: false, invalid: [] } },
    { name: 'trailing comma', input: 'max-age=60,', expected: { maxAge: 60 } },

    // 31-40: Invalid delta-seconds values & error reporting
    { name: 'empty value max-age=', input: 'max-age=', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'negative value max-age=-1', input: 'max-age=-1', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'decimal value max-age=1.5', input: 'max-age=1.5', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'plus sign max-age=+60', input: 'max-age=+60', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'non-numeric value max-age=abc', input: 'max-age=abc', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'huge value capped at 2147483648 (max-age=99999999999)', input: 'max-age=99999999999', expected: { maxAge: 2147483648 } },
    { name: 'huge s-maxage capped at 2147483648', input: 's-maxage=2147483650', expected: { sMaxAge: 2147483648 } },
    { name: 'empty s-maxage=', input: 's-maxage=', expected: { sMaxAge: 0, invalid: ['s-maxage'] } },
    { name: 'non-numeric s-maxage=xyz', input: 's-maxage=xyz', expected: { sMaxAge: 0, invalid: ['s-maxage'] } },
    { name: 'invalid max-stale=bad', input: 'max-stale=bad', expected: { maxStale: 0, invalid: ['max-stale'] } },

    // 41-48: Duplicates, multi-line, extensions
    { name: 'duplicate identical max-age (max-age=60, max-age=60)', input: 'max-age=60, max-age=60', expected: { maxAge: 60, invalid: [] } },
    { name: 'duplicate conflicting max-age (max-age=60, max-age=120)', input: 'max-age=60, max-age=120', expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'duplicate conflicting s-maxage', input: 's-maxage=10, s-maxage=20', expected: { sMaxAge: 0, invalid: ['s-maxage'] } },
    { name: 'multi-line header array', input: ['public', 'max-age=300', 'no-transform'], expected: { public: true, maxAge: 300, noTransform: true } },
    { name: 'multi-line header array with conflicting duplicate', input: ['max-age=10', 'max-age=20'], expected: { maxAge: 0, invalid: ['max-age'] } },
    { name: 'unknown extension without value', input: 'custom-directive', expected: { extensions: { 'custom-directive': true } } },
    { name: 'unknown extension with value', input: 'custom-token=foobar', expected: { extensions: { 'custom-token': 'foobar' } } },
    { name: 'combined real-world header', input: 'public, max-age=86400, s-maxage=3600, must-revalidate', expected: { public: true, maxAge: 86400, sMaxAge: 3600, mustRevalidate: true } },
  ];

  it(`runs at least 40 table-driven test cases (actual: ${tableCases.length})`, () => {
    expect(tableCases.length).toBeGreaterThanOrEqual(40);
    for (const tc of tableCases) {
      const res = parseCacheControl(tc.input);
      for (const [key, val] of Object.entries(tc.expected)) {
        expect(res[key as keyof ParsedCacheControl], `Failed in case: ${tc.name} for key ${key}`).toEqual(val);
      }
    }
  });

  it('parses a 64 KB header in under 20 ms without catastrophic regex backtracking', () => {
    // Generate a 64 KB header string with various tokens and quoted values
    const segment = 'public, max-age=3600, s-maxage=1800, ext="quoted string, with comma", no-transform, ';
    const repetitions = Math.ceil((64 * 1024) / segment.length);
    const largeHeader = segment.repeat(repetitions);
    expect(largeHeader.length).toBeGreaterThan(64 * 1024);

    // Warm up JIT
    parseCacheControl(largeHeader);

    const start = performance.now();
    const result = parseCacheControl(largeHeader);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(20);
    expect(result.public).toBe(true);
    expect(result.maxAge).toBe(3600);
    expect(result.sMaxAge).toBe(1800);
  });

  it('never throws on 1,000 random fuzz strings', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789=,"\'\\ \t\r\n-_;:/+.*!@#$%^&()[]{}';
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(Math.random() * 80) + 1;
      let fuzzStr = '';
      for (let j = 0; j < len; j++) {
        fuzzStr += chars[Math.floor(Math.random() * chars.length)];
      }

      expect(() => {
        const res = parseCacheControl(fuzzStr);
        expect(typeof res.noStore).toBe('boolean');
        expect(Array.isArray(res.invalid)).toBe(true);
      }).not.toThrow();
    }
  });
});
