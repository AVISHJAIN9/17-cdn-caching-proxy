import { describe, it, expect } from 'vitest';
import {
  normalizeIncomingHeaders,
  normalizeHeadersForForwarding,
} from '../src/proxy/headers.js';

describe('Feature 4: Header normalization (RFC 9110)', () => {
  it('lowercases all header names', () => {
    const raw = {
      'Content-Type': 'application/json',
      'X-CUSTOM-HEADER': 'test-value',
      AUTHORIZATION: 'Bearer token123',
    };

    const normalized = normalizeIncomingHeaders(raw);
    expect(normalized).toEqual({
      'content-type': 'application/json',
      'x-custom-header': 'test-value',
      authorization: 'Bearer token123',
    });
  });

  it('joins duplicate headers correctly with comma, except set-cookie', () => {
    // Array of raw alternating headers simulating req.rawHeaders
    const rawHeadersArray = [
      'Accept',
      'text/html',
      'Accept',
      'application/xhtml+xml',
      'X-Forwarded-For',
      '198.51.100.1',
      'X-Forwarded-For',
      '198.51.100.2',
      'Set-Cookie',
      'session=abc; Path=/',
      'Set-Cookie',
      'theme=dark; Path=/',
    ];

    const normalized = normalizeIncomingHeaders(rawHeadersArray);

    expect(normalized['accept']).toBe('text/html, application/xhtml+xml');
    expect(normalized['x-forwarded-for']).toBe('198.51.100.1, 198.51.100.2');
    expect(normalized['set-cookie']).toEqual([
      'session=abc; Path=/',
      'theme=dark; Path=/',
    ]);
  });

  it('leaves set-cookie untouched as an array when given dictionary with array', () => {
    const raw = {
      'Set-Cookie': ['a=1', 'b=2'],
      Accept: ['text/html', 'application/json'],
    };

    const normalized = normalizeIncomingHeaders(raw);
    expect(normalized['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(normalized['accept']).toBe('text/html, application/json');
  });

  it('removes standard hop-by-hop headers when forwarding upstream', () => {
    const headers = {
      host: 'client.example.com',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic',
      'proxy-authorization': 'Basic credentials',
      te: 'trailers',
      trailer: 'X-Checksum',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'proxy-connection': 'keep-alive',
      'content-type': 'text/plain',
      'user-agent': 'curl/8.0.0',
    };

    const forwarded = normalizeHeadersForForwarding(headers, {
      originHost: 'origin.internal:8080',
    });

    expect(forwarded).not.toHaveProperty('connection');
    expect(forwarded).not.toHaveProperty('keep-alive');
    expect(forwarded).not.toHaveProperty('proxy-authenticate');
    expect(forwarded).not.toHaveProperty('proxy-authorization');
    expect(forwarded).not.toHaveProperty('te');
    expect(forwarded).not.toHaveProperty('trailer');
    expect(forwarded).not.toHaveProperty('transfer-encoding');
    expect(forwarded).not.toHaveProperty('upgrade');
    expect(forwarded).not.toHaveProperty('proxy-connection');

    // Standard headers remain
    expect(forwarded['content-type']).toBe('text/plain');
    expect(forwarded['user-agent']).toBe('curl/8.0.0');
  });

  it('removes custom headers named inside Connection header value', () => {
    const headers = {
      connection: 'foo, X-Custom-Hop, bar',
      foo: 'should-be-removed',
      'x-custom-hop': 'also-removed',
      bar: 'also-removed',
      'keep-me': 'preserved',
    };

    const forwarded = normalizeHeadersForForwarding(headers, {
      originHost: 'origin.internal',
    });

    expect(forwarded).not.toHaveProperty('connection');
    expect(forwarded).not.toHaveProperty('foo');
    expect(forwarded).not.toHaveProperty('x-custom-hop');
    expect(forwarded).not.toHaveProperty('bar');
    expect(forwarded['keep-me']).toBe('preserved');
  });

  it('discards spoofed incoming X-Forwarded-* headers when trustForwardedHeaders is false (default)', () => {
    const headers = {
      host: 'cdn.example.com',
      'x-forwarded-for': '203.0.113.195, 10.0.0.1',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'fake-origin.com',
      'user-agent': 'client',
    };

    const forwarded = normalizeHeadersForForwarding(headers, {
      clientIp: '192.0.2.1',
      isTls: false,
      originHost: 'real-origin.internal',
      trustForwardedHeaders: false,
    });

    // Spoofed values discarded; starts fresh with real client IP and HTTP protocol
    expect(forwarded['x-forwarded-for']).toBe('192.0.2.1');
    expect(forwarded['x-forwarded-proto']).toBe('http');
    expect(forwarded['x-forwarded-host']).toBe('cdn.example.com');
  });

  it('preserves and appends to X-Forwarded-* headers when trustForwardedHeaders is true', () => {
    const headers = {
      host: 'cdn.example.com',
      'x-forwarded-for': '203.0.113.195',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'original-client.com',
    };

    const forwarded = normalizeHeadersForForwarding(headers, {
      clientIp: '192.0.2.1',
      isTls: false,
      originHost: 'real-origin.internal',
      trustForwardedHeaders: true,
    });

    // Appended to existing chain
    expect(forwarded['x-forwarded-for']).toBe('203.0.113.195, 192.0.2.1');
    expect(forwarded['x-forwarded-proto']).toBe('https');
    expect(forwarded['x-forwarded-host']).toBe('original-client.com');
  });

  it('adds Via: "1.1 cdn-proxy" or appends to existing Via header', () => {
    const withoutVia = { host: 'example.com' };
    const forwarded1 = normalizeHeadersForForwarding(withoutVia, {
      originHost: 'origin.internal',
    });
    expect(forwarded1['via']).toBe('1.1 cdn-proxy');

    const withVia = {
      host: 'example.com',
      via: '1.0 upstream-cache',
    };
    const forwarded2 = normalizeHeadersForForwarding(withVia, {
      originHost: 'origin.internal',
    });
    expect(forwarded2['via']).toBe('1.0 upstream-cache, 1.1 cdn-proxy');
  });

  it('Host header: sends origin host by default; preserves client host if preserveHost is true', () => {
    const headers = { host: 'client.requested.domain:8080' };

    // Default: sends origin host
    const defaultForwarded = normalizeHeadersForForwarding(headers, {
      originHost: 'origin.internal:9000',
      preserveHost: false,
    });
    expect(defaultForwarded['host']).toBe('origin.internal:9000');

    // preserveHost: true keeps client host
    const preservedForwarded = normalizeHeadersForForwarding(headers, {
      originHost: 'origin.internal:9000',
      preserveHost: true,
    });
    expect(preservedForwarded['host']).toBe('client.requested.domain:8080');
  });
});
