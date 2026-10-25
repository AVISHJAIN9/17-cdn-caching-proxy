import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { buildUpstreamConditionals } from '../src/cache/upstream-conditionals.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 1: Conditional Revalidation (src/cache/upstream-conditionals.ts)', () => {
  describe('Pure: buildUpstreamConditionals (16 cases)', () => {
    it('1. etag only returns ifNoneMatch and hasValidators=true', () => {
      const res = buildUpstreamConditionals({ etagRaw: '"strong-tag"' });
      expect(res.ifNoneMatch).toBe('"strong-tag"');
      expect(res.ifModifiedSince).toBeUndefined();
      expect(res.hasValidators).toBe(true);
    });

    it('2. last-modified only returns ifModifiedSince and hasValidators=true', () => {
      const res = buildUpstreamConditionals({
        lastModifiedRaw: 'Sat, 01 Jan 2000 00:00:00 GMT',
      });
      expect(res.ifNoneMatch).toBeUndefined();
      expect(res.ifModifiedSince).toBe('Sat, 01 Jan 2000 00:00:00 GMT');
      expect(res.hasValidators).toBe(true);
    });

    it('3. both validators returns both and hasValidators=true (RFC 9111 §4.3.1)', () => {
      const res = buildUpstreamConditionals({
        etagRaw: '"v1"',
        lastModifiedRaw: 'Sun, 02 Jan 2000 00:00:00 GMT',
      });
      expect(res.ifNoneMatch).toBe('"v1"');
      expect(res.ifModifiedSince).toBe('Sun, 02 Jan 2000 00:00:00 GMT');
      expect(res.hasValidators).toBe(true);
    });

    it('4. weak tag preserved byte-for-byte in ifNoneMatch', () => {
      const res = buildUpstreamConditionals({ etagRaw: 'W/"weak-v1"' });
      expect(res.ifNoneMatch).toBe('W/"weak-v1"');
      expect(res.hasValidators).toBe(true);
    });

    it('5. weak tag with last-modified returns both', () => {
      const res = buildUpstreamConditionals({
        etagRaw: 'W/"weak-v1"',
        lastModifiedRaw: 'Mon, 03 Jan 2000 00:00:00 GMT',
      });
      expect(res.ifNoneMatch).toBe('W/"weak-v1"');
      expect(res.ifModifiedSince).toBe('Mon, 03 Jan 2000 00:00:00 GMT');
      expect(res.hasValidators).toBe(true);
    });

    it('6. tag containing a comma preserved byte-for-byte', () => {
      const res = buildUpstreamConditionals({ etagRaw: '"tag,with,comma"' });
      expect(res.ifNoneMatch).toBe('"tag,with,comma"');
      expect(res.hasValidators).toBe(true);
    });

    it('7. tag containing spaces preserved byte-for-byte', () => {
      const res = buildUpstreamConditionals({ etagRaw: '"tag with spaces"' });
      expect(res.ifNoneMatch).toBe('"tag with spaces"');
      expect(res.hasValidators).toBe(true);
    });

    it('8. tag containing escaped quotes preserved byte-for-byte', () => {
      const res = buildUpstreamConditionals({ etagRaw: '"\\"escaped\\""' });
      expect(res.ifNoneMatch).toBe('"\\"escaped\\""');
      expect(res.hasValidators).toBe(true);
    });

    it('9. neither validator returns undefined and hasValidators=false', () => {
      const res = buildUpstreamConditionals({});
      expect(res.ifNoneMatch).toBeUndefined();
      expect(res.ifModifiedSince).toBeUndefined();
      expect(res.hasValidators).toBe(false);
    });

    it('10. undefined fields return undefined and hasValidators=false', () => {
      const res = buildUpstreamConditionals({
        etagRaw: undefined,
        lastModifiedRaw: undefined,
      });
      expect(res.ifNoneMatch).toBeUndefined();
      expect(res.ifModifiedSince).toBeUndefined();
      expect(res.hasValidators).toBe(false);
    });

    it('11. empty strings return undefined and hasValidators=false', () => {
      const res = buildUpstreamConditionals({
        etagRaw: '',
        lastModifiedRaw: '',
      });
      expect(res.ifNoneMatch).toBeUndefined();
      expect(res.ifModifiedSince).toBeUndefined();
      expect(res.hasValidators).toBe(false);
    });

    it('12. preserves exact case byte-for-byte', () => {
      const res = buildUpstreamConditionals({
        etagRaw: '"AbCdEf"',
        lastModifiedRaw: 'TUE, 04 Jan 2000 00:00:00 GMT',
      });
      expect(res.ifNoneMatch).toBe('"AbCdEf"');
      expect(res.ifModifiedSince).toBe('TUE, 04 Jan 2000 00:00:00 GMT');
    });

    it('13. preserves complex SHA-256 etag string byte-for-byte', () => {
      const shaEtag = '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"';
      const res = buildUpstreamConditionals({ etagRaw: shaEtag });
      expect(res.ifNoneMatch).toBe(shaEtag);
    });

    it('14. preserves punctuation and special chars inside quoted etag', () => {
      const special = '"version:1.2.3;build=99?foo=bar#baz"';
      const res = buildUpstreamConditionals({ etagRaw: special });
      expect(res.ifNoneMatch).toBe(special);
    });

    it('15. preserves weak prefix with lowercase w/ if stored', () => {
      const res = buildUpstreamConditionals({ etagRaw: 'W/"lowercase-test"' });
      expect(res.ifNoneMatch).toBe('W/"lowercase-test"');
    });

    it('16. preserves RFC 850 date string byte-for-byte if stored as lastModifiedRaw', () => {
      const rfc850 = 'Tuesday, 08-Feb-94 14:12:22 GMT';
      const res = buildUpstreamConditionals({ lastModifiedRaw: rfc850 });
      expect(res.ifModifiedSince).toBe(rfc850);
      expect(res.hasValidators).toBe(true);
    });
  });

  describe('Integration: Upstream Conditionals & 200-to-Conditional Rule', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let proxyPort: number;
    let clock: FakeClock;
    let store: MemoryStore;
    const baseTime = 1_000_000_000_000;

    beforeEach(async () => {
      resetStats();
      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          originPort = (originServer.address() as any).port;
          resolve();
        });
      });

      clock = new FakeClock(baseTime);
      store = new MemoryStore();
      proxyListener = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        store,
        cache: {
          enabled: true,
          debugHeaders: true,
          revalidate: { enabled: true },
          maxObjectBytes: 5 * 1024 * 1024,
        },
      });
      proxyPort = proxyListener.httpPort!;
    });

    afterEach(async () => {
      await proxyListener?.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    async function getOriginLogs(): Promise<any[]> {
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${originPort}/__log`, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(JSON.parse(text)));
          res.on('error', reject);
        });
      });
    }

    it('1. Upstream request for a stale entry carries exactly stored validators and NOT client conditionals', async () => {
      // 1. Prime cache with max-age=10
      const miss = await rawRequest(
        proxyPort,
        'GET /reval/user1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      const storedEntry = (store as any).entries.values().next().value;
      expect(storedEntry).toBeDefined();
      expect(storedEntry?.etagRaw).toBe('"user1-v1"');
      expect(storedEntry?.lastModifiedRaw).toBe('Sat, 01 Jan 2000 00:00:00 GMT');

      // Clear origin log
      await rawRequest(
        originPort,
        'POST /__reset HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // 2. Advance clock past freshness lifetime (max-age=60s)
      clock.advance(70_000);

      // 3. Client sends conditional request with completely different client validators
      const clientReq = await rawRequest(
        proxyPort,
        'GET /reval/user1 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "client-different-tag"\r\nIf-Modified-Since: Mon, 10 Jan 2022 00:00:00 GMT\r\nConnection: close\r\n\r\n'
      );

      // Verify what reached the origin via /__log
      const logs = await getOriginLogs();
      const revalReq = logs.find((l) => l.path === '/reval/user1');
      expect(revalReq).toBeDefined();
      // Must carry proxy's stored validators, NOT client's
      expect(revalReq.ifNoneMatch).toBe('"user1-v1"');
      expect(revalReq.ifModifiedSince).toBe('Sat, 01 Jan 2000 00:00:00 GMT');
    });

    it('2. revalidate.enabled=false behaves as Batch 6 (deletes stale entry and treats as plain miss)', async () => {
      await proxyListener.stop();
      proxyListener = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        clock,
        store,
        cache: {
          enabled: true,
          debugHeaders: true,
          revalidate: { enabled: false }, // Revalidation disabled
        },
      });
      proxyPort = proxyListener.httpPort!;

      // Prime cache
      await rawRequest(
        proxyPort,
        'GET /reval/item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Clear origin log
      await rawRequest(
        originPort,
        'POST /__reset HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Advance clock past expiration
      clock.advance(70_000);

      // Request after expiration
      const res = await rawRequest(
        proxyPort,
        'GET /reval/item1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-cache-reason']).toBe('expired');

      // Origin should NOT receive conditional headers
      const logs = await getOriginLogs();
      const originReq = logs.find((l) => l.path === '/reval/item1');
      expect(originReq).toBeDefined();
      expect(originReq.ifNoneMatch).toBeUndefined();
      expect(originReq.ifModifiedSince).toBeUndefined();
    });

    it('3. A stale entry without validators is lazily deleted and treated as a plain miss', async () => {
      // Configure item without etag or last-modified
      const configBody = JSON.stringify({ etagMode: 'none', lm: '', cc: 'max-age=10' });
      await rawRequest(
        originPort,
        `POST /__config/no-validators HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(configBody)}\r\nConnection: close\r\n\r\n${configBody}`
      );

      const miss = await rawRequest(
        proxyPort,
        'GET /reval/no-validators HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');

      // Advance clock past lifetime
      clock.advance(15_000);

      const second = await rawRequest(
        proxyPort,
        'GET /reval/no-validators HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(second.headers['x-cache']).toBe('MISS');
      expect(second.headers['x-cache-reason']).toBe('expired');
    });

    it('4. 200-to-conditional rule: true miss with client If-None-Match forwards it intact and origin 200 is stored', async () => {
      // Clear logs
      await rawRequest(
        originPort,
        'POST /__reset HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Send client conditional on un-cached URL
      const clientConditional = await rawRequest(
        proxyPort,
        'GET /reval/new-item HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "non-existent-tag"\r\nConnection: close\r\n\r\n'
      );
      expect(clientConditional.statusCode).toBe(200);
      expect(clientConditional.headers['x-cache']).toBe('MISS');

      // Verify origin saw the client's If-None-Match
      const logs = await getOriginLogs();
      const originReq = logs.find((l) => l.path === '/reval/new-item');
      expect(originReq).toBeDefined();
      expect(originReq.ifNoneMatch).toBe('"non-existent-tag"');

      // The response must now be STORED in cache (Batch 6 limitation fixed)
      const hit = await rawRequest(
        proxyPort,
        'GET /reval/new-item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(hit.statusCode).toBe(200);
      expect(hit.headers['x-cache']).toBe('HIT');
    });

    it('5. 200-to-conditional rule: origin 304 on a true miss is passed through unstored with origin_304_no_entry', async () => {
      // Configure origin item with matching version
      // Send client conditional that matches the origin's initial version "item304-v1"
      const res = await rawRequest(
        proxyPort,
        'GET /reval/item304 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "item304-v1"\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(304);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-cache-reason']).toBe('origin_304_no_entry');

      // Must NOT be stored in cache
      expect(store.stats().entries).toBe(0);
    });
  });
});
