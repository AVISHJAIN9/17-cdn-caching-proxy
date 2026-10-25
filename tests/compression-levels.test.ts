import { describe, it, expect } from 'vitest';
import {
  validateCompressionLevel,
  DEFAULT_COMPRESSION_LEVELS,
  compressBuffer,
} from '../src/compression/codecs.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 72: Compression levels', () => {
  describe('Default Levels and Range Validation', () => {
    it('applies documented default compression levels when unspecified', () => {
      expect(validateCompressionLevel('gzip', undefined)).toBe(DEFAULT_COMPRESSION_LEVELS.gzip);
      expect(DEFAULT_COMPRESSION_LEVELS.gzip).toBe(6);

      expect(validateCompressionLevel('br', undefined)).toBe(DEFAULT_COMPRESSION_LEVELS.br);
      expect(DEFAULT_COMPRESSION_LEVELS.br).toBe(4);

      expect(validateCompressionLevel('zstd', undefined)).toBe(DEFAULT_COMPRESSION_LEVELS.zstd);
      expect(DEFAULT_COMPRESSION_LEVELS.zstd).toBe(3);
    });

    it('rejects out-of-range or non-integer levels with a clear error for gzip (valid: 1-9)', () => {
      expect(() => validateCompressionLevel('gzip', 0)).toThrow(/between 1 and 9/i);
      expect(() => validateCompressionLevel('gzip', 10)).toThrow(/between 1 and 9/i);
      expect(() => validateCompressionLevel('gzip', -1)).toThrow(/between 1 and 9/i);
      expect(() => validateCompressionLevel('gzip', 4.5)).toThrow(/must be an integer/i);

      expect(validateCompressionLevel('gzip', 1)).toBe(1);
      expect(validateCompressionLevel('gzip', 9)).toBe(9);
    });

    it('rejects out-of-range or non-integer levels with a clear error for brotli (valid: 0-11)', () => {
      expect(() => validateCompressionLevel('br', -1)).toThrow(/between 0 and 11/i);
      expect(() => validateCompressionLevel('br', 12)).toThrow(/between 0 and 11/i);
      expect(() => validateCompressionLevel('br', 2.3)).toThrow(/must be an integer/i);

      expect(validateCompressionLevel('br', 0)).toBe(0);
      expect(validateCompressionLevel('br', 11)).toBe(11);
    });

    it('rejects out-of-range or non-integer levels with a clear error for zstd (valid: 1-22)', () => {
      expect(() => validateCompressionLevel('zstd', 0)).toThrow(/between 1 and 22/i);
      expect(() => validateCompressionLevel('zstd', 23)).toThrow(/between 1 and 22/i);
      expect(() => validateCompressionLevel('zstd', 5.5)).toThrow(/must be an integer/i);

      expect(validateCompressionLevel('zstd', 1)).toBe(1);
      expect(validateCompressionLevel('zstd', 22)).toBe(22);
    });
  });

  describe('Compression Efficiency across Levels', () => {
    const fixture = Buffer.from('Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(1000));

    it('produces output at a higher level no larger than a lower level for gzip', async () => {
      const fast = await compressBuffer(fixture, 'gzip', { level: 1 });
      const best = await compressBuffer(fixture, 'gzip', { level: 9 });
      expect(best.length).toBeLessThanOrEqual(fast.length);
    });

    it('produces output at a higher level no larger than a lower level for brotli', async () => {
      const fast = await compressBuffer(fixture, 'br', { level: 1 });
      const best = await compressBuffer(fixture, 'br', { level: 9 });
      expect(best.length).toBeLessThanOrEqual(fast.length);
    });

    it('produces output at a higher level no larger than a lower level for zstd', async () => {
      const fast = await compressBuffer(fixture, 'zstd', { level: 1 });
      const best = await compressBuffer(fixture, 'zstd', { level: 9 });
      expect(best.length).toBeLessThanOrEqual(fast.length);
    });
  });

  describe('Proxy Startup Validation for Compression Levels', () => {
    it('fails immediately at proxy startup when an invalid compression level is configured', async () => {
      await expect(
        createAndStartProxy({
          httpHost: '127.0.0.1',
          httpPort: 0,
          originUrl: 'http://127.0.0.1:9090',
          compression: {
            levels: {
              gzip: 99, // invalid level
            },
          },
        })
      ).rejects.toThrow(/between 1 and 9/i);
    });
  });
});
