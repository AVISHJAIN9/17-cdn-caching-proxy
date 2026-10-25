import { describe, it, expect } from 'vitest';
import { freshnessLifetimeMs } from '../src/cache/lifetime.js';
import { parseCacheControl } from '../src/cache/cache-control.js';

describe('Feature 2: Max-Age freshness lifetime calculation (src/cache/lifetime.ts)', () => {
  it('calculates freshness lifetime in milliseconds (max-age=60 gives 60000)', () => {
    const cc = parseCacheControl('max-age=60');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 60000, source: 'max-age' });
  });

  it('s-maxage beats max-age (s-maxage=120, max-age=60)', () => {
    const cc = parseCacheControl('s-maxage=120, max-age=60');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 120000, source: 's-maxage' });
  });

  it('handles max-age=0 correctly', () => {
    const cc = parseCacheControl('max-age=0');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'max-age' });
  });

  it('caps huge max-age at configured maxTtlMs', () => {
    const cc = parseCacheControl('max-age=999999999');
    // Default maxTtlMs is 86400000 (1 day)
    const resultDefault = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(resultDefault).toEqual({ lifetimeMs: 86400000, source: 'max-age' });

    // Custom maxTtlMs
    const resultCustom = freshnessLifetimeMs(
      { cacheControl: cc, dateMs: 1000000 },
      { maxTtlMs: 3600000 }
    );
    expect(resultCustom).toEqual({ lifetimeMs: 3600000, source: 'max-age' });
  });

  it('caps huge s-maxage at configured maxTtlMs', () => {
    const cc = parseCacheControl('s-maxage=999999999');
    const result = freshnessLifetimeMs(
      { cacheControl: cc, dateMs: 1000000 },
      { maxTtlMs: 50000 }
    );
    expect(result).toEqual({ lifetimeMs: 50000, source: 's-maxage' });
  });

  it('returns lifetime 0 with source "invalid" on invalid max-age', () => {
    const cc = parseCacheControl('max-age=invalid');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'invalid' });
  });

  it('returns lifetime 0 with source "invalid" on conflicting max-age', () => {
    const cc = parseCacheControl('max-age=10, max-age=20');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'invalid' });
  });

  it('returns lifetime 0 with source "invalid" on conflicting s-maxage', () => {
    const cc = parseCacheControl('s-maxage=10, s-maxage=20');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'invalid' });
  });

  it('returns source "none" with lifetime 0 when no caching directives are provided', () => {
    const cc = parseCacheControl('public');
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'none' });
  });

  it('returns source "none" when cache-control is empty', () => {
    const cc = parseCacheControl(undefined);
    const result = freshnessLifetimeMs({ cacheControl: cc, dateMs: 1000000 });
    expect(result).toEqual({ lifetimeMs: 0, source: 'none' });
  });
});
