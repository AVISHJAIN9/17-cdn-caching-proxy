import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { evaluateClientConditionals } from '../src/cache/preconditions.js';
import { parseEntityTag } from '../src/cache/etag.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';

describe('Feature 4: If-None-Match (src/cache/preconditions.ts, src/cache/serve.ts)', () => {
  describe('Unit: evaluateClientConditionals with If-None-Match (18 cases)', () => {
    const strongTag = parseEntityTag('"v1"')!;
    const weakTag = parseEntityTag('W/"v1"')!;
    const commaTag = parseEntityTag('"tag,comma"')!;

    it('1. Non-GET method returns proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'POST', ifNoneMatch: '"v1"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('method_not_get');
    });

    it('2. PUT method returns proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'PUT', ifNoneMatch: '*' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('method_not_get');
    });

    it('3. INM absent returns proceed with no_conditionals', () => {
      const res = evaluateClientConditionals(
        { method: 'GET' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('no_conditionals');
    });

    it('4. INM "*" returns not_modified', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '*' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_star');
    });

    it('5. INM "*" returns not_modified even when stored entry has no etag', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '*' },
        {}
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_star');
    });

    it('6. INM matching strong tag gives not_modified', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"v1"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('7. INM weak tag W/"v1" vs strong stored "v1" matches (weak match)', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: 'W/"v1"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('8. INM strong tag "v1" vs weak stored W/"v1" matches (weak match)', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"v1"' },
        { etag: weakTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('9. INM weak tag W/"v1" vs weak stored W/"v1" matches', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: 'W/"v1"' },
        { etag: weakTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('10. INM tag list "x", "v1", "y" matches', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"x", "v1", "y"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('11. INM tag list without match gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"x", "y", "z"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_no_match');
    });

    it('12. INM tag list against entry with no etag gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"v1"' },
        {}
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('no_stored_etag');
    });

    it('13. INM invalid unquoted "abc" gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: 'abc' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_invalid');
    });

    it('14. INM invalid "W/abc" gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: 'W/abc' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_invalid');
    });

    it('15. INM invalid unterminated quote gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"v1' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_invalid');
    });

    it('16. INM invalid star mixed with tags gives proceed', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '*, "v1"' },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('proceed');
      expect(res.reason).toBe('if_none_match_invalid');
    });

    it('17. INM comma inside quotes matches correctly', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: '"other", "tag,comma"' },
        { etag: commaTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });

    it('18. INM array of multiple header values joins and matches', () => {
      const res = evaluateClientConditionals(
        { method: 'GET', ifNoneMatch: ['"foo"', '"v1"'] },
        { etag: strongTag }
      );
      expect(res.outcome).toBe('not_modified');
      expect(res.reason).toBe('if_none_match_match');
    });
  });

  describe('Integration: Real proxy, real demo origin, real sockets (16 cases)', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let store: MemoryStore;
    let clock: FakeClock;
    let proxyPort: number;

    const baseTime = 1000000000000;

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
          maxObjectBytes: 5 * 1024 * 1024,
        },
      });
      proxyPort = proxyListener.httpPort!;
    });

    afterEach(async () => {
      await proxyListener?.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    async function getOriginStats(): Promise<any> {
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${originPort}/__stats`, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(JSON.parse(text)));
          res.on('error', reject);
        });
      });
    }

    it('1. INM matching strong tag gives 304 and origin /__stats shows no new request', async () => {
      // Prime the cache
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');

      const originStatsBefore = await getOriginStats();

      // Conditional GET with matching ETag
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
      expect(hit304.headers['etag']).toBe('"v1"');
      expect(hit304.body.toString('utf-8')).toBe('');

      // Origin stats must show NO new request
      const originStatsAfter = await getOriginStats();
      expect(originStatsAfter.requests).toBe(originStatsBefore.requests);
    });

    it('2. weak/strong cross matches: W/"v1" vs stored "v1" gives 304', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: W/"v1"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('3. strong request tag "v1" vs stored weak W/"v1" gives 304', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=W%2F%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=W%2F%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('4. list "x", "v1", "y" matches stored "v1" and gives 304', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "x", "v1", "y"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('5. "*" matches and gives 304', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: *\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('6. no match gives 200 HIT with the full body', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const body = miss.body.toString('utf-8');

      const hit200 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "other"\r\nConnection: close\r\n\r\n'
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(body);
    });

    it('7. entry without ETag gives 200 HIT with full body', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['etag']).toBeUndefined();

      const hit200 = await rawRequest(
        proxyPort,
        'GET /validators?cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(hit200.statusCode).toBe(200);
      expect(hit200.headers['x-cache']).toBe('HIT');
      expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));
    });

    it('8. invalid INM ("abc", "W/abc", unterminated) gives 200 HIT', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      for (const invalidHeader of ['abc', 'W/abc', '"unterminated']) {
        const hit200 = await rawRequest(
          proxyPort,
          `GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: ${invalidHeader}\r\nConnection: close\r\n\r\n`
        );
        expect(hit200.statusCode).toBe(200);
        expect(hit200.headers['x-cache']).toBe('HIT');
        expect(hit200.body.toString('utf-8')).toBe(miss.body.toString('utf-8'));
      }
    });

    it('9. comma-inside-quotes tag matches correctly', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22tag%2Cwith%2Ccomma%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22tag%2Cwith%2Ccomma%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "other", "tag,with,comma"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['x-cache']).toBe('HIT');
    });

    it('10. 304 carries exactly the allowed headers and NO body (raw bytes check)', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const rawRes = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(rawRes.statusCode).toBe(304);

      // Verify no body bytes followed the header terminator
      expect(rawRes.body.length).toBe(0);
      expect(rawRes.body.toString('utf-8')).toBe('');

      // Verify allowed headers
      expect(rawRes.headers['etag']).toBe('"v1"');
      expect(rawRes.headers['cache-control']).toBe('max-age=60');
      expect(rawRes.headers['date']).toBeDefined();
      expect(rawRes.headers['age']).toBeDefined();
      expect(rawRes.headers['via']).toContain('1.1 cdn-proxy');
      expect(rawRes.headers['x-cache']).toBe('HIT');

      // Verify forbidden headers are NOT present
      expect(rawRes.headers['content-length']).toBeUndefined();
      expect(rawRes.headers['content-type']).toBeUndefined();
      expect(rawRes.headers['content-encoding']).toBeUndefined();
      expect(rawRes.headers['content-range']).toBeUndefined();
      expect(rawRes.headers['transfer-encoding']).toBeUndefined();
    });

    it('11. 304 has one Date, a correct Age and Via', async () => {
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      clock.advance(15000); // 15 seconds later

      const hit304 = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(hit304.statusCode).toBe(304);
      expect(hit304.headers['age']).toBe('15');
      expect(hit304.headers['via']).toContain('1.1 cdn-proxy');

      // Check single date header
      const rawText = hit304.text;
      const dateMatches = rawText.match(/\r\nDate:[^\r\n]+/gi);
      expect(dateMatches?.length).toBe(1);
    });

    it('12. stale entry plus INM goes to origin and is not stored (with revalidate disabled)', async () => {
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
          revalidate: { enabled: false },
          maxObjectBytes: 5 * 1024 * 1024,
        },
      });
      proxyPort = proxyListener.httpPort!;

      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Advance clock past 60s max-age
      clock.advance(65000);

      const staleRes = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      expect(staleRes.headers['x-cache']).toBe('MISS');
      expect(staleRes.headers['x-cache-reason']).toBe('expired');

      // Verify origin saw the conditional request
      const stats = await getOriginStats();
      expect(stats.conditionalRequests).toBeGreaterThanOrEqual(1);

      // Under Batch 7 200-to-conditional rule, 200 responses are now storable
      const entries = (store as any).entries;
      let found = false;
      for (const e of entries.values()) {
        if (e.keyString.includes('/validators')) found = true;
      }
      expect(found).toBe(true);
    });

    it('13. INM on a never-stored URL is forwarded with header intact and origin 304 passes through', async () => {
      // origin304=1 instructs demo origin to answer 304 if INM matches etag
      const res = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v9%22&origin304=1 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v9"\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(304);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-cache-reason']).toBe('origin_304_no_entry');

      // Origin stats verify conditionalRequests incremented
      const stats = await getOriginStats();
      expect(stats.conditionalRequests).toBeGreaterThanOrEqual(1);
    });

    it('14. two pipelined requests (304 then 200) come back complete and in order on one raw socket', async () => {
      // Prime entry
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const expectedBody = miss.body;

      // Send two pipelined requests on single TCP socket
      const pipelinePayload =
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\n\r\n' +
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "nomatch"\r\nConnection: close\r\n\r\n';

      const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => {
          socket.write(pipelinePayload);
        });
        socket.on('data', (d) => chunks.push(d));
        socket.on('end', resolve);
        socket.on('error', reject);
      });

      const fullOutput = Buffer.concat(chunks).toString('utf-8');
      const responses = fullOutput.split('HTTP/1.1 ');
      expect(responses.length).toBe(3); // leading empty string + 2 responses

      // Response 1: 304 Not Modified
      expect(responses[1]).toContain('304 Not Modified');
      expect(responses[1].toLowerCase()).toContain('x-cache: hit');
      // 304 ends with \r\n\r\n
      expect(responses[1].endsWith('\r\n\r\n')).toBe(true);

      // Response 2: 200 OK with full body
      expect(responses[2]).toContain('200 OK');
      expect(responses[2].toLowerCase()).toContain('x-cache: hit');
      expect(responses[2]).toContain(expectedBody.toString('utf-8'));
    });

    it('15. hitCount and notModified stats are accurate', async () => {
      // Prime entry
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );

      // Serve 2x 304 hits
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n'
      );
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: *\r\nConnection: close\r\n\r\n'
      );

      // Serve 1x 200 hit
      await rawRequest(
        proxyPort,
        'GET /validators?etag=%22v1%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: "other"\r\nConnection: close\r\n\r\n'
      );

      const stats = store.stats();
      // Total hits: 2 (from 304) + 1 (from 200) = 3 hits
      expect(stats.hits).toBe(3);
      // notModified count: 2
      expect(stats.notModified).toBe(2);
    });

    it('16. OPTIONS * still receives 200 and Date from clock', async () => {
      const res = await rawRequest(
        proxyPort,
        'OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['date']).toBeDefined();
    });
  });
});
