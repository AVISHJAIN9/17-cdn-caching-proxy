import { describe, it, expect } from 'vitest';
import {
  parseOriginsConfig,
  joinBasePath,
  redactConfig,
} from '../src/config/origins.js';
import { runConfigCheck } from '../src/config/cli.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Feature 1: Origin config (src/config/origins.ts)', () => {
  it('parses valid origins map with defaultOrigin', () => {
    const config = parseOriginsConfig(
      {
        origins: {
          main: {
            url: 'https://api.example.com:8443/v1',
            hostHeader: 'api.example.com:8443',
            verifyTls: true,
            maxSockets: 100,
            timeouts: {
              upstreamHeadersMs: 5000,
            },
          },
        },
        defaultOrigin: 'main',
      },
      {}
    );

    expect(config.defaultOrigin).toBe('main');
    expect(config.origins.main.url).toBe('https://api.example.com:8443/v1');
    expect(config.origins.main.verifyTls).toBe(true);
    expect(config.origins.main.timeouts?.upstreamHeadersMs).toBe(5000);
  });

  it('rejects unsupported URL protocols', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'ftp://example.com' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('URL protocol must be "http:" or "https:"');
  });

  it('rejects credentials in origin URL', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'http://user:secret@example.com' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('Origin URL must not contain credentials (user:pass@)');
  });

  it('rejects query strings in origin URL', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'http://example.com/api?env=prod' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('Origin URL must not contain query strings');
  });

  it('rejects URL fragments in origin URL', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'http://example.com/api#anchor' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('Origin URL must not contain URL fragments (#)');
  });

  it('rejects port numbers out of range', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'http://example.com:70000' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('Port out of range');
  });

  it('rejects invalid hostHeader format', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { def: { url: 'http://example.com', hostHeader: 'http://foo' } },
          defaultOrigin: 'def',
        },
        {}
      )
    ).toThrow('hostHeader must be a valid host[:port]');
  });

  it('rejects empty origin id', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { '   ': { url: 'http://example.com' } },
          defaultOrigin: '   ',
        },
        {}
      )
    ).toThrow('Origin ID must not be empty or whitespace');
  });

  it('rejects defaultOrigin that is not in origins map', () => {
    expect(() =>
      parseOriginsConfig(
        {
          origins: { primary: { url: 'http://example.com' } },
          defaultOrigin: 'non_existent',
        },
        {}
      )
    ).toThrow('defaultOrigin "non_existent" does not exist in configured origins');
  });

  it('joins base paths cleanly without double slashes', () => {
    expect(joinBasePath('https://api.example.com/v1', '/users')).toBe('/v1/users');
    expect(joinBasePath('https://api.example.com/v1/', '/users')).toBe('/v1/users');
    expect(joinBasePath('https://api.example.com/v1/', 'users')).toBe('/v1/users');
    expect(joinBasePath('https://api.example.com', '/users')).toBe('/users');
    expect(joinBasePath('https://api.example.com/', '/users')).toBe('/users');
    expect(joinBasePath('https://api.example.com/v1', '')).toBe('/v1');
    expect(joinBasePath('https://api.example.com', '')).toBe('/');
  });

  it('supports Batch 1 legacy origin config format', () => {
    const config = parseOriginsConfig(
      {
        origin: {
          url: 'http://legacy-origin.local:9090',
        },
      },
      {}
    );

    expect(config.defaultOrigin).toBe('default');
    expect(config.origins.default.url).toBe('http://legacy-origin.local:9090');
  });

  it('applies ORIGIN_URL environment variable override with highest precedence', () => {
    const config = parseOriginsConfig(
      {
        origins: {
          custom: { url: 'http://file-config.local:8080' },
        },
        defaultOrigin: 'custom',
      },
      {
        ORIGIN_URL: 'https://env-override.example.com',
      }
    );

    expect(config.defaultOrigin).toBe('custom');
    expect(config.origins.custom.url).toBe('https://env-override.example.com');
  });

  it('redacts sensitive information in redactConfig', () => {
    const config = {
      origins: {
        api: { url: 'https://user:mypassword@api.example.com/v1' },
      },
      defaultOrigin: 'api',
    };
    const redacted = redactConfig(config);
    expect(redacted.origins.api.url).toBe('https://user:******@api.example.com/v1');
  });

  it('config:check CLI exits with 0 for valid config and 1 for invalid', () => {
    const tmpDir = path.resolve(process.cwd(), 'scratch');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const validPath = path.join(tmpDir, 'valid-config.json');
    fs.writeFileSync(
      validPath,
      JSON.stringify({
        origins: {
          backend: { url: 'http://127.0.0.1:9090' },
        },
        defaultOrigin: 'backend',
      })
    );

    const invalidPath = path.join(tmpDir, 'invalid-config.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        origins: {
          backend: { url: 'ftp://unsupported.com' },
        },
        defaultOrigin: 'missing',
      })
    );

    expect(runConfigCheck(validPath)).toBe(0);
    expect(runConfigCheck(invalidPath)).toBe(1);
    expect(runConfigCheck('non-existent-path.json')).toBe(1);
  });
});
