import { describe, it, expect } from 'vitest';
import {
  parseAcceptEncoding,
  getEncodingWeight,
  isEncodingAcceptable,
  normalizeAcceptEncoding,
  type ParsedEncodingPreference,
} from '../src/compression/accept-encoding.js';

describe('Feature 70: Accept-Encoding parsing', () => {
  describe('Table-driven parsing of Accept-Encoding header', () => {
    it('parses "gzip, br;q=0.5, *;q=0" with correct tokens and q-values', () => {
      const result = parseAcceptEncoding('gzip, br;q=0.5, *;q=0');
      expect(result).toEqual([
        { encoding: 'gzip', q: 1.0 },
        { encoding: 'br', q: 0.5 },
        { encoding: '*', q: 0.0 },
      ]);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(true);
      expect(getEncodingWeight(result, 'gzip')).toBe(1.0);
      expect(isEncodingAcceptable(result, 'br')).toBe(true);
      expect(getEncodingWeight(result, 'br')).toBe(0.5);
      // identity is not explicitly listed, but * has q=0, so identity is refused
      expect(isEncodingAcceptable(result, 'identity')).toBe(false);
      expect(getEncodingWeight(result, 'identity')).toBe(0.0);
      // any other encoding is refused due to *;q=0
      expect(isEncodingAcceptable(result, 'deflate')).toBe(false);
      expect(getEncodingWeight(result, 'deflate')).toBe(0.0);
    });

    it('parses "identity;q=0" and marks identity as explicitly refused', () => {
      const result = parseAcceptEncoding('identity;q=0');
      expect(result).toEqual([{ encoding: 'identity', q: 0.0 }]);
      expect(isEncodingAcceptable(result, 'identity')).toBe(false);
      expect(getEncodingWeight(result, 'identity')).toBe(0.0);
    });

    it('parses "gzip;q=0" and marks gzip as explicitly refused', () => {
      const result = parseAcceptEncoding('gzip;q=0');
      expect(result).toEqual([{ encoding: 'gzip', q: 0.0 }]);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(false);
      expect(getEncodingWeight(result, 'gzip')).toBe(0.0);
      // identity is implicitly acceptable
      expect(isEncodingAcceptable(result, 'identity')).toBe(true);
    });

    it('parses "*" alone and assigns default q=1.0', () => {
      const result = parseAcceptEncoding('*');
      expect(result).toEqual([{ encoding: '*', q: 1.0 }]);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(true);
      expect(getEncodingWeight(result, 'gzip')).toBe(1.0);
      expect(isEncodingAcceptable(result, 'identity')).toBe(true);
      expect(getEncodingWeight(result, 'identity')).toBe(1.0);
    });

    it('handles empty header correctly with identity acceptable', () => {
      const result = parseAcceptEncoding('');
      expect(result).toEqual([]);
      expect(isEncodingAcceptable(result, 'identity')).toBe(true);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(false);
    });

    it('handles absent (undefined/null) header with identity acceptable', () => {
      const resultUndef = parseAcceptEncoding(undefined);
      expect(resultUndef).toEqual([]);
      expect(isEncodingAcceptable(resultUndef, 'identity')).toBe(true);
      expect(getEncodingWeight(resultUndef, 'identity')).toBe(1.0);

      const resultNull = parseAcceptEncoding(null);
      expect(resultNull).toEqual([]);
      expect(isEncodingAcceptable(resultNull, 'identity')).toBe(true);
      expect(getEncodingWeight(resultNull, 'identity')).toBe(1.0);
    });

    it('handles uppercase tokens and parameters case-insensitively', () => {
      const result = parseAcceptEncoding('GZIP, BR;Q=0.8, DEFLATE;Q=0');
      expect(result).toEqual([
        { encoding: 'gzip', q: 1.0 },
        { encoding: 'br', q: 0.8 },
        { encoding: 'deflate', q: 0.0 },
      ]);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(true);
      expect(getEncodingWeight(result, 'gzip')).toBe(1.0);
      expect(isEncodingAcceptable(result, 'br')).toBe(true);
      expect(getEncodingWeight(result, 'br')).toBe(0.8);
      expect(isEncodingAcceptable(result, 'deflate')).toBe(false);
      expect(getEncodingWeight(result, 'deflate')).toBe(0.0);
    });

    it('handles duplicate tokens deterministically by using the last or highest valid preference', () => {
      const result = parseAcceptEncoding('gzip;q=0.5, gzip;q=0.9');
      // When duplicate tokens appear, last preference takes precedence
      expect(result.filter((r: ParsedEncodingPreference) => r.encoding === 'gzip').length).toBe(1);
      expect(getEncodingWeight(result, 'gzip')).toBe(0.9);
    });

    it('handles extraneous whitespace cleanly around commas and semicolons', () => {
      const result = parseAcceptEncoding('   gzip  ,   br  ;   q=0.7   ');
      expect(result).toEqual([
        { encoding: 'gzip', q: 1.0 },
        { encoding: 'br', q: 0.7 },
      ]);
    });

    it('gracefully handles q-values above 1 or below 0 without crashing', () => {
      // q values must be between 0 and 1; out of range values are clamped or treated as invalid (0)
      const resultHigh = parseAcceptEncoding('gzip;q=1.5, br;q=2');
      expect(resultHigh.find((r: ParsedEncodingPreference) => r.encoding === 'gzip')?.q).toBe(1.0);

      const resultLow = parseAcceptEncoding('gzip;q=-0.5');
      expect(resultLow.find((r: ParsedEncodingPreference) => r.encoding === 'gzip')?.q).toBe(0.0);
    });

    it('handles non-numeric q-values by defaulting or ignoring gracefully', () => {
      const result = parseAcceptEncoding('gzip;q=invalid, br;q=');
      // Invalid q values should fall back safely to 0 or 1 without throwing
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles overlong headers safely without crashing or hanging', () => {
      const tokens: string[] = ['gzip;q=1.0'];
      for (let i = 0; i < 2000; i++) {
        tokens.push(`custom${i};q=0.5`);
      }
      const overlong = tokens.join(', ');
      expect(overlong.length).toBeGreaterThan(20000);

      const start = Date.now();
      const result = parseAcceptEncoding(overlong);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
      expect(isEncodingAcceptable(result, 'gzip')).toBe(true);
      expect(getEncodingWeight(result, 'gzip')).toBe(1.0);
    });
  });

  describe('normalizeAcceptEncoding for variant cache keying', () => {
    it('normalizes "gzip, br" and "br, gzip" to identical sorted representation', () => {
      const norm1 = normalizeAcceptEncoding('gzip, br');
      const norm2 = normalizeAcceptEncoding('br, gzip');
      expect(norm1).toBe(norm2);
      expect(norm1).toBe('br,gzip');
    });

    it('excludes refused (q=0) encodings from normalized representation', () => {
      const norm1 = normalizeAcceptEncoding('gzip, br;q=0');
      expect(norm1).toBe('gzip');
    });

    it('returns "identity" or empty string when no compression accepted', () => {
      const norm = normalizeAcceptEncoding('gzip;q=0, br;q=0');
      expect(norm).toBe('');
    });
  });
});
