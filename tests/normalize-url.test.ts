import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  InvalidPercentEncodingError,
} from '../src/proxy/normalize-url.js';

describe('Feature 3: URL normalization (RFC 3986 section 6)', () => {
  const tableTestCases: Array<{
    name: string;
    input: string;
    expected: string;
  }> = [
    // 1. Lowercase scheme
    {
      name: 'lowercase scheme',
      input: 'HTTP://example.com/',
      expected: 'http://example.com/',
    },
    // 2. Lowercase HTTPS scheme
    {
      name: 'lowercase HTTPS scheme',
      input: 'HTTPS://example.com/',
      expected: 'https://example.com/',
    },
    // 3. Lowercase uppercase host
    {
      name: 'lowercase uppercase host',
      input: 'http://EXAMPLE.COM/',
      expected: 'http://example.com/',
    },
    // 4. Lowercase mixed-case host
    {
      name: 'lowercase mixed-case host',
      input: 'http://eXaMpLe.CoM/path',
      expected: 'http://example.com/path',
    },
    // 5. Remove default HTTP port 80
    {
      name: 'remove default port 80 for http',
      input: 'http://example.com:80/',
      expected: 'http://example.com/',
    },
    // 6. Remove default HTTPS port 443
    {
      name: 'remove default port 443 for https',
      input: 'https://example.com:443/',
      expected: 'https://example.com/',
    },
    // 7. Preserve non-default port 8080
    {
      name: 'preserve non-default port 8080 for http',
      input: 'http://example.com:8080/',
      expected: 'http://example.com:8080/',
    },
    // 8. Preserve non-default port 8443 for https
    {
      name: 'preserve non-default port 8443 for https',
      input: 'https://example.com:8443/',
      expected: 'https://example.com:8443/',
    },
    // 9. Preserve port 80 for https (non-default for https)
    {
      name: 'preserve port 80 for https',
      input: 'https://example.com:80/',
      expected: 'https://example.com:80/',
    },
    // 10. Preserve port 443 for http (non-default for http)
    {
      name: 'preserve port 443 for http',
      input: 'http://example.com:443/',
      expected: 'http://example.com:443/',
    },
    // 11. Empty path becomes "/" in absolute URL
    {
      name: 'empty path becomes / in absolute URL',
      input: 'http://example.com',
      expected: 'http://example.com/',
    },
    // 12. Empty path with default port
    {
      name: 'empty path with default port becomes /',
      input: 'http://example.com:80',
      expected: 'http://example.com/',
    },
    // 13. Empty path in origin form
    {
      name: 'empty path in origin form becomes /',
      input: '',
      expected: '/',
    },
    // 14. Resolve simple dot segment /./
    {
      name: 'resolve single dot segment /./',
      input: '/a/./b',
      expected: '/a/b',
    },
    // 15. Resolve double dot segment /../
    {
      name: 'resolve double dot segment /../',
      input: '/a/b/../c',
      expected: '/a/c',
    },
    // 16. Combined dot segments from RFC
    {
      name: 'resolve /a/./b/../c -> /a/c',
      input: '/a/./b/../c',
      expected: '/a/c',
    },
    // 17. Trailing single dot in dot-segments
    {
      name: 'trailing single dot in dot segment /a/b/.',
      input: '/a/b/.',
      expected: '/a/b/',
    },
    // 18. Trailing double dot in dot-segments
    {
      name: 'trailing double dot in dot segment /a/b/..',
      input: '/a/b/..',
      expected: '/a/',
    },
    // 19. Dot segments at beginning
    {
      name: 'dot segments at beginning ./a/../b',
      input: './a/../b',
      expected: '/b',
    },
    // 20. Double dot going past root clamps to root
    {
      name: 'double dot going past root clamps to root',
      input: '/a/../../b',
      expected: '/b',
    },
    // 21. Preserve double slashes (do NOT collapse)
    {
      name: 'preserve double slashes',
      input: '/a//b///c',
      expected: '/a//b///c',
    },
    // 22. Uppercase percent-encoded hex digits (%2f -> %2F)
    {
      name: 'uppercase percent-encoded hex digits (%2f -> %2F)',
      input: '/path/%2f/test',
      expected: '/path/%2F/test',
    },
    // 23. Mixed case hex digits normalized to uppercase
    {
      name: 'mixed case hex digits (%3a -> %3A, %7b -> %7B)',
      input: '/path/%3a/%7b',
      expected: '/path/%3A/%7B',
    },
    // 24. Decode percent-encoded unreserved ASCII ALPHA (%41 -> A)
    {
      name: 'decode percent-encoded unreserved ASCII uppercase ALPHA (%41 -> A)',
      input: '/%41%42%43',
      expected: '/ABC',
    },
    // 25. Decode percent-encoded unreserved lowercase ALPHA (%61 -> a)
    {
      name: 'decode percent-encoded unreserved lowercase ALPHA (%61 -> a)',
      input: '/%61%62%63',
      expected: '/abc',
    },
    // 26. Decode percent-encoded unreserved DIGIT (%31 -> 1)
    {
      name: 'decode percent-encoded unreserved DIGIT (%30%39 -> 09)',
      input: '/%30%39',
      expected: '/09',
    },
    // 27. Decode percent-encoded unreserved hyphen, dot, underscore, tilde (%2D, %2E, %5F, %7E)
    {
      name: 'decode percent-encoded unreserved symbols (%2D, %2E, %5F, %7E)',
      input: '/%2d%2e%5f%7e',
      expected: '/-._~',
    },
    // 28. Keep reserved characters percent-encoded (encoded slash %2F stays %2F)
    {
      name: 'keep reserved encoded slash %2F',
      input: '/foo%2Fbar',
      expected: '/foo%2Fbar',
    },
    // 29. Keep reserved encoded question mark %3F
    {
      name: 'keep reserved encoded question mark %3F',
      input: '/foo%3Fbar',
      expected: '/foo%3Fbar',
    },
    // 30. Remove URL fragment in origin-form
    {
      name: 'remove URL fragment in origin form',
      input: '/path#section-1',
      expected: '/path',
    },
    // 31. Remove URL fragment in absolute form
    {
      name: 'remove URL fragment in absolute form',
      input: 'http://example.com/page?query=val#frag',
      expected: 'http://example.com/page?query=val',
    },
    // 32. IPv6 host normalization
    {
      name: 'IPv6 host with port 80 removed',
      input: 'http://[2001:DB8::1]:80/status',
      expected: 'http://[2001:db8::1]/status',
    },
    // 33. IPv6 host with non-default port preserved
    {
      name: 'IPv6 host with port 8080 preserved',
      input: 'http://[2001:db8::1]:8080/status',
      expected: 'http://[2001:db8::1]:8080/status',
    },
    // 34. Query containing "?" preserved
    {
      name: 'query containing question mark "?"',
      input: '/search?q=what?where&filter=1',
      expected: '/search?q=what?where&filter=1',
    },
    // 35. Query containing "%" and hex uppercase
    {
      name: 'query containing percent-encoded characters and symbols',
      input: '/search?q=hello%20world&tag=%2f%41',
      expected: '/search?q=hello%20world&tag=%2FA',
    },
    // 36. Complex absolute URL with dot-segments, port 80, uppercase host, percent-encoding, and fragment
    {
      name: 'complex combination test',
      input: 'HTTP://MY-SERVER.ORG:80/a/./b/../c/%68%65%6c%6c%6f?k=%2f#anchor',
      expected: 'http://my-server.org/a/c/hello?k=%2F',
    },
  ];

  it('passes all table-driven normalization test cases (>= 30 cases)', () => {
    expect(tableTestCases.length).toBeGreaterThanOrEqual(30);

    for (const tc of tableTestCases) {
      const actual = normalizeUrl(tc.input);
      expect(actual, `Failed test case: "${tc.name}" (input: "${tc.input}")`).toBe(
        tc.expected
      );
    }
  });

  describe('Invalid percent-encoding errors', () => {
    const invalidInputs = [
      '%zz',
      '/path/%2',
      '/path/%',
      '/bad%g1/path',
      'http://example.com/foo%1g',
      'http://example.com/foo?bar=%z',
    ];

    for (const input of invalidInputs) {
      it(`throws InvalidPercentEncodingError for invalid input "${input}"`, () => {
        expect(() => normalizeUrl(input)).toThrow(InvalidPercentEncodingError);
      });
    }
  });
});
