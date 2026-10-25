import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateCacheKey, normalizeHostForKey } from '../src/cache/key.js';

describe('Feature 1: Cache key generation (src/cache/key.ts)', () => {
  const baseInput = {
    namespace: 'default',
    originId: 'default',
    method: 'GET',
    host: 'example.com',
    normalizedPath: '/api/v1/users',
    normalizedQuery: 'page=1&sort=asc',
  };

  it('same input deterministically produces the exact same keyString and keyHash', () => {
    const key1 = generateCacheKey(baseInput);
    const key2 = generateCacheKey({ ...baseInput });

    expect(key1.keyString).toBe(key2.keyString);
    expect(key1.keyHash).toBe(key2.keyHash);
    expect(key1.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('known-answer test with fixed expected sha256', () => {
    const input = {
      namespace: 'tenant-1',
      originId: 'api-origin',
      method: 'GET',
      host: 'cdn.example.org',
      normalizedPath: '/items/42',
      normalizedQuery: 'view=summary',
    };
    const key = generateCacheKey(input);
    const expectedKeyString = JSON.stringify([
      'v1',
      'tenant-1',
      'api-origin',
      'GET',
      'cdn.example.org',
      '/items/42',
      'view=summary',
    ]);
    const expectedHash = crypto.createHash('sha256').update(expectedKeyString).digest('hex');

    expect(key.keyString).toBe(expectedKeyString);
    expect(key.keyHash).toBe(expectedHash);
  });

  it('changing each single field changes the key', () => {
    const baseKey = generateCacheKey(baseInput);

    const changedNamespace = generateCacheKey({ ...baseInput, namespace: 'other' });
    expect(changedNamespace.keyString).not.toBe(baseKey.keyString);
    expect(changedNamespace.keyHash).not.toBe(baseKey.keyHash);

    const changedOrigin = generateCacheKey({ ...baseInput, originId: 'origin-2' });
    expect(changedOrigin.keyString).not.toBe(baseKey.keyString);
    expect(changedOrigin.keyHash).not.toBe(baseKey.keyHash);

    const changedMethod = generateCacheKey({ ...baseInput, method: 'HEAD' });
    expect(changedMethod.keyString).not.toBe(baseKey.keyString);
    expect(changedMethod.keyHash).not.toBe(baseKey.keyHash);

    const changedHost = generateCacheKey({ ...baseInput, host: 'sub.example.com' });
    expect(changedHost.keyString).not.toBe(baseKey.keyString);
    expect(changedHost.keyHash).not.toBe(baseKey.keyHash);

    const changedPath = generateCacheKey({ ...baseInput, normalizedPath: '/api/v1/user' });
    expect(changedPath.keyString).not.toBe(baseKey.keyString);
    expect(changedPath.keyHash).not.toBe(baseKey.keyHash);

    const changedQuery = generateCacheKey({ ...baseInput, normalizedQuery: 'page=2&sort=asc' });
    expect(changedQuery.keyString).not.toBe(baseKey.keyString);
    expect(changedQuery.keyHash).not.toBe(baseKey.keyHash);
  });

  it('prevents delimiter-injection and boundary-collision bugs via JSON array encoding', () => {
    // Delimiter injection: "|" or commas or quotes in path vs query
    const k1 = generateCacheKey({
      ...baseInput,
      normalizedPath: '/a',
      normalizedQuery: 'b=1',
    });
    const k2 = generateCacheKey({
      ...baseInput,
      normalizedPath: '/a?b=1',
      normalizedQuery: '',
    });
    expect(k1.keyString).not.toBe(k2.keyString);
    expect(k1.keyHash).not.toBe(k2.keyHash);

    // Host / path boundary trick
    const k3 = generateCacheKey({
      ...baseInput,
      host: 'example.com/api',
      normalizedPath: '/users',
    });
    const k4 = generateCacheKey({
      ...baseInput,
      host: 'example.com',
      normalizedPath: '/api/users',
    });
    expect(k3.keyString).not.toBe(k4.keyString);
    expect(k3.keyHash).not.toBe(k4.keyHash);

    // Array formatting check
    const k5 = generateCacheKey({
      ...baseInput,
      normalizedPath: '["v1", "inject"]',
    });
    const k6 = generateCacheKey({
      ...baseInput,
      normalizedPath: 'inject',
    });
    expect(k5.keyString).not.toBe(k6.keyString);
    expect(k5.keyHash).not.toBe(k6.keyHash);
  });

  it('normalizes host: lowercases and removes default ports 80 and 443', () => {
    expect(normalizeHostForKey('Example.COM')).toBe('example.com');
    expect(normalizeHostForKey('EXAMPLE.COM:80')).toBe('example.com');
    expect(normalizeHostForKey('example.com:443')).toBe('example.com');
    expect(normalizeHostForKey('example.com:8080')).toBe('example.com:8080');

    const keyWithPort80 = generateCacheKey({ ...baseInput, host: 'EXAMPLE.COM:80' });
    const keyWithoutPort = generateCacheKey({ ...baseInput, host: 'example.com' });
    expect(keyWithPort80.keyString).toBe(keyWithoutPort.keyString);
    expect(keyWithPort80.keyHash).toBe(keyWithoutPort.keyHash);
  });

  it('honors includeHost=false by setting host to empty string', () => {
    const keyWithHostFalse1 = generateCacheKey({ ...baseInput, host: 'host-a.com', includeHost: false });
    const keyWithHostFalse2 = generateCacheKey({ ...baseInput, host: 'host-b.com', includeHost: false });

    expect(keyWithHostFalse1.keyString).toBe(keyWithHostFalse2.keyString);
    expect(keyWithHostFalse1.keyHash).toBe(keyWithHostFalse2.keyHash);
    expect(JSON.parse(keyWithHostFalse1.keyString)[4]).toBe('');
  });

  it('defaults namespace to "default" if omitted', () => {
    const key = generateCacheKey({
      originId: 'origin-1',
      method: 'GET',
      host: 'localhost',
      normalizedPath: '/',
      normalizedQuery: '',
    });
    const parsed = JSON.parse(key.keyString);
    expect(parsed[1]).toBe('default');
  });
});
