import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  negotiateEncoding,
  ensureVaryAcceptEncoding,
} from '../src/compression/negotiate.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 69: Content negotiation', () => {
  describe('Pure Content Negotiation Logic', () => {
    const supported = ['zstd', 'br', 'gzip'];
    const preference = ['zstd', 'br', 'gzip'];

    it('chooses deterministically according to proxy preference when q-values tie', () => {
      // Both gzip and br have default q=1.0
      const result = negotiateEncoding('gzip, br', supported, preference);
      expect(result.encoding).toBe('br'); // br is higher in preference than gzip
      expect(result.acceptable).toBe(true);
      expect(result.q).toBe(1.0);

      // When zstd, br, and gzip all have q=1.0
      const resultAll = negotiateEncoding('gzip, zstd, br', supported, preference);
      expect(resultAll.encoding).toBe('zstd'); // zstd is top preference
    });

    it('allows client q-values to override proxy preference when they differ', () => {
      // Proxy prefers br over gzip, but client gives gzip q=1.0 and br q=0.5
      const result = negotiateEncoding('gzip;q=1.0, br;q=0.5', supported, preference);
      expect(result.encoding).toBe('gzip');
      expect(result.q).toBe(1.0);
      expect(result.acceptable).toBe(true);

      // Client prefers br (0.9) over zstd (0.4)
      const resultBr = negotiateEncoding('zstd;q=0.4, br;q=0.9', supported, preference);
      expect(resultBr.encoding).toBe('br');
      expect(resultBr.q).toBe(0.9);
    });

    it('selects identity when client only offers unsupported encodings and identity is acceptable', () => {
      const result = negotiateEncoding('deflate, compress', supported, preference);
      expect(result.encoding).toBe('identity');
      expect(result.acceptable).toBe(true);
      expect(result.q).toBeGreaterThan(0);
    });

    it('rejects with acceptable=false (406 Not Acceptable) when no encoding matches and identity;q=0', () => {
      const result = negotiateEncoding('deflate, identity;q=0', supported, preference);
      expect(result.acceptable).toBe(false);
      expect(result.encoding).toBe('identity');

      const resultWildcard = negotiateEncoding('deflate, *;q=0', supported, preference);
      expect(resultWildcard.acceptable).toBe(false);
    });

    it('handles absent or empty Accept-Encoding header with identity', () => {
      const resultUndef = negotiateEncoding(undefined, supported, preference);
      expect(resultUndef.encoding).toBe('identity');
      expect(resultUndef.acceptable).toBe(true);

      const resultEmpty = negotiateEncoding('', supported, preference);
      expect(resultEmpty.encoding).toBe('identity');
      expect(resultEmpty.acceptable).toBe(true);
    });

    it('handles explicit refusal (q=0) of supported encodings', () => {
      const result = negotiateEncoding('gzip;q=0, br;q=0, zstd;q=0', supported, preference);
      expect(result.encoding).toBe('identity');
      expect(result.acceptable).toBe(true);
    });
  });

  describe('ensureVaryAcceptEncoding helper', () => {
    it('sets Vary: Accept-Encoding if Vary is not present', () => {
      const headers: Record<string, string | string[] | undefined> = {};
      ensureVaryAcceptEncoding(headers);
      expect(headers['vary']).toBe('Accept-Encoding');
    });

    it('appends Accept-Encoding to existing Vary header without duplicating', () => {
      const headers: Record<string, string | string[] | undefined> = {
        vary: 'Origin, User-Agent',
      };
      ensureVaryAcceptEncoding(headers);
      expect(headers['vary']).toBe('Origin, User-Agent, Accept-Encoding');

      // Calling again should not duplicate
      ensureVaryAcceptEncoding(headers);
      expect(headers['vary']).toBe('Origin, User-Agent, Accept-Encoding');
    });
  });

  describe('End-to-End Proxy Content Negotiation & Cache Hits', () => {
    let originServer: http.Server;
    let originPort: number;
    let proxy: any;
    let originHits = 0;

    afterEach(async () => {
      if (proxy) {
        await proxy.stop();
      }
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
      originHits = 0;
    });

    it('serves 406 Not Acceptable when identity is refused and no supported encodings match', async () => {
      originServer = http.createServer((_req, res) => {
        originHits++;
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=60' });
        res.end('Hello negotiation');
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      // Request with unsupported encoding and identity refused
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: { 'Accept-Encoding': 'unsupported-codec;q=1.0, identity;q=0' },
      });

      expect(res.status).toBe(406);
    });

    it('adds Vary: Accept-Encoding to responses and serves 2 clients from the SAME cached object (1 upstream fetch)', async () => {
      originServer = http.createServer((_req, res) => {
        originHits++;
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        });
        res.end('This is a cacheable text content for content negotiation tests.');
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });
      const proxyPort = proxy.httpPort!;

      // Client 1 sends Accept-Encoding: gzip
      const res1 = await fetch(`http://127.0.0.1:${proxyPort}/shared-doc`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });
      expect(res1.status).toBe(200);
      expect(res1.headers.get('vary')).toMatch(/Accept-Encoding/i);
      expect(originHits).toBe(1);

      // Client 2 sends Accept-Encoding: identity (or no encoding) for the SAME resource
      const res2 = await fetch(`http://127.0.0.1:${proxyPort}/shared-doc`, {
        headers: { 'Accept-Encoding': 'identity' },
      });
      expect(res2.status).toBe(200);
      expect(res2.headers.get('vary')).toMatch(/Accept-Encoding/i);
      expect(res2.headers.get('x-cache')).toBe('HIT');
      // Assert exactly 1 upstream fetch occurred across both clients!
      expect(originHits).toBe(1);
    });
  });
});
