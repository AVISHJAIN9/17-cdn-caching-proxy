import { describe, it, expect } from 'vitest';
import { normalizeQueryForKey, KeyNormalizationOptions } from '../src/cache/key-normalize.js';

describe('Feature 2: Key normalization (src/cache/key-normalize.ts)', () => {
  interface TestCase {
    desc: string;
    input: string;
    options?: KeyNormalizationOptions;
    expected: string;
  }

  const testCases: TestCase[] = [
    { desc: '1. Empty query returns empty string', input: '', expected: '' },
    { desc: '2. Lone ? returns empty string', input: '?', expected: '' },
    { desc: '3. Simple parameter intact', input: 'a=1', expected: 'a=1' },
    { desc: '4. Parameters sorted alphabetically', input: 'b=1&a=2', expected: 'a=2&b=1' },
    { desc: '5. Leading question mark stripped', input: '?b=1&a=2', expected: 'a=2&b=1' },
    { desc: '6. Duplicate parameters maintain stable relative order', input: 'a=2&a=1', expected: 'a=2&a=1' },
    { desc: '7. Interleaved duplicates sorted with order preserved', input: 'b=1&a=2&c=3&a=1', expected: 'a=2&a=1&b=1&c=3' },
    { desc: '8. Empty segments dropped (double ampersand)', input: 'a=1&&b=2', expected: 'a=1&b=2' },
    { desc: '9. Trailing ampersand dropped', input: 'a=1&b=2&', expected: 'a=1&b=2' },
    { desc: '10. Leading ampersand dropped', input: '&a=1&b=2', expected: 'a=1&b=2' },
    { desc: '11. Only ampersands returns empty', input: '&&&&', expected: '' },
    { desc: '12. Parameter without value preserved', input: 'flag', expected: 'flag' },
    { desc: '13. "a" and "a=" are treated as distinct parameters', input: 'a=&a', expected: 'a=&a' },
    { desc: '14. Parameter with empty value preserved', input: 'b=2&a=', expected: 'a=&b=2' },
    { desc: '15. Encoded ampersand (%26) is NOT split or decoded', input: 'a=1%262&b=3', expected: 'a=1%262&b=3' },
    { desc: '16. Encoded equals (%3D) is NOT decoded into separator', input: 'a%3Db=1&c=2', expected: 'a%3Db=1&c=2' },
    { desc: '17. Plus sign (+) is NOT converted to space', input: 'q=hello+world', expected: 'q=hello+world' },
    { desc: '18. Case-sensitive parameter names stay distinct', input: 'A=1&a=2', expected: 'A=1&a=2' },
    { desc: '19. Prefix ignore pattern utm_* drops matching parameters', input: 'utm_source=google&q=search&utm_medium=cpc', options: { ignoreQueryParams: ['utm_*'] }, expected: 'q=search' },
    { desc: '20. Prefix ignore does NOT match non-prefix substrings', input: 'xutm_source=1&utm_source=2', options: { ignoreQueryParams: ['utm_*'] }, expected: 'xutm_source=1' },
    { desc: '21. Exact ignore parameter match', input: 'session=abc&q=test', options: { ignoreQueryParams: ['session'] }, expected: 'q=test' },
    { desc: '22. Exact ignore does NOT drop prefix extensions', input: 'session_id=abc&session=123', options: { ignoreQueryParams: ['session'] }, expected: 'session_id=abc' },
    { desc: '23. Multiple ignore patterns combined', input: 'utm_campaign=winter&fbclid=xyz&q=shoes&page=2', options: { ignoreQueryParams: ['utm_*', 'fbclid'] }, expected: 'page=2&q=shoes' },
    { desc: '24. All parameters ignored returns empty string', input: 'utm_source=a&utm_medium=b', options: { ignoreQueryParams: ['utm_*'] }, expected: '' },
    { desc: '25. ignoreQuery=true drops entire query regardless of content', input: 'a=1&b=2', options: { ignoreQuery: true }, expected: '' },
    { desc: '26. sortQuery=false preserves original parameter order', input: 'z=1&a=2&m=3', options: { sortQuery: false }, expected: 'z=1&a=2&m=3' },
    { desc: '27. Whitespace in values preserved without trimming', input: 'a= test &b=2', expected: 'a= test &b=2' },
    { desc: '28. Parameters with multiple equals in value intact', input: 'redirect=https://example.com?foo=bar&id=1', expected: 'id=1&redirect=https://example.com?foo=bar' },
    { desc: '29. Non-ASCII percent-encoded bytes preserved', input: 'city=%E6%9D%B1%E4%BA%AC&country=jp', expected: 'city=%E6%9D%B1%E4%BA%AC&country=jp' },
    { desc: '30. Numeric-like parameter names sorted lexicographically', input: '10=a&2=b&1=c', expected: '1=c&10=a&2=b' },
  ];

  for (const tc of testCases) {
    it(tc.desc, () => {
      const actual = normalizeQueryForKey(tc.input, tc.options);
      expect(actual).toBe(tc.expected);
    });
  }

  it('proves reordered query with ignored marketing params maps to identical normalized query', () => {
    const q1 = '?utm_source=x&b=1&a=2';
    const q2 = '?a=2&b=1';
    const opts = { ignoreQueryParams: ['utm_*'] };

    expect(normalizeQueryForKey(q1, opts)).toBe('a=2&b=1');
    expect(normalizeQueryForKey(q2, opts)).toBe('a=2&b=1');
  });

  it('performance: query with 2,000 parameters normalizes in under 50 ms', () => {
    const params: string[] = [];
    for (let i = 2000; i >= 1; i--) {
      params.push(`param_${String(i).padStart(4, '0')}=val_${i}`);
    }
    const rawQuery = params.join('&');

    const start = performance.now();
    const result = normalizeQueryForKey(rawQuery, {
      sortQuery: true,
      ignoreQueryParams: ['param_0001', 'param_199*'],
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    expect(result).not.toContain('param_0001=');
    expect(result).not.toContain('param_1999=');
    expect(result.startsWith('param_0002=')).toBe(true);
  });
});
