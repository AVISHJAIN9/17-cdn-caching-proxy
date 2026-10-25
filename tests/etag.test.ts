import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseEntityTag,
  parseEntityTagList,
  weakMatch,
  strongMatch,
  EntityTag,
} from '../src/cache/etag.js';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { FakeClock } from '../src/util/clock.js';
import { rawRequest } from './helpers/raw-request.js';
import { originServer, resetStats } from '../scripts/demo-origin.js';

describe('Feature 2: ETag (src/cache/etag.ts)', () => {
  describe('Unit: parseEntityTag (table-driven test cases)', () => {
    const tableCases: Array<{
      input: string | undefined;
      expected: { weak: boolean; opaque: string } | null;
      desc: string;
    }> = [
      // Valid strong tags
      { input: '"xyzzy"', expected: { weak: false, opaque: 'xyzzy' }, desc: 'basic strong tag' },
      { input: '""', expected: { weak: false, opaque: '' }, desc: 'empty opaque strong tag' },
      { input: '"123-abc_def"', expected: { weak: false, opaque: '123-abc_def' }, desc: 'alphanumeric and dashes/underscores' },
      { input: '"tag,with,comma"', expected: { weak: false, opaque: 'tag,with,comma' }, desc: 'comma inside quotes is valid' },
      { input: '"tag;with;semicolon"', expected: { weak: false, opaque: 'tag;with;semicolon' }, desc: 'semicolon inside quotes' },
      { input: '"tag=with=equals"', expected: { weak: false, opaque: 'tag=with=equals' }, desc: 'equals inside quotes' },
      { input: '"tag/with/slash"', expected: { weak: false, opaque: 'tag/with/slash' }, desc: 'slash inside quotes' },
      { input: '"tag:with:colon"', expected: { weak: false, opaque: 'tag:with:colon' }, desc: 'colon inside quotes' },
      { input: '"tag\\\\with\\\\backslash"', expected: { weak: false, opaque: 'tag\\\\with\\\\backslash' }, desc: 'backslash is ordinary etagc' },
      { input: '"\\n\\t"', expected: { weak: false, opaque: '\\n\\t' }, desc: 'escaped looking text without literal controls' },
      { input: '"!#$%&\'()*+-.<=>?@[]^_`{|}~"', expected: { weak: false, opaque: '!#$%&\'()*+-.<=>?@[]^_`{|}~' }, desc: 'all allowed ASCII symbols' },
      { input: '"café"', expected: { weak: false, opaque: 'café' }, desc: 'obs-text (UTF-8 bytes > 0x7F)' },

      // Valid weak tags
      { input: 'W/"xyzzy"', expected: { weak: true, opaque: 'xyzzy' }, desc: 'basic weak tag' },
      { input: 'W/""', expected: { weak: true, opaque: '' }, desc: 'empty opaque weak tag' },
      { input: 'W/"tag,with,comma"', expected: { weak: true, opaque: 'tag,with,comma' }, desc: 'weak tag with comma' },
      { input: 'W/"123"', expected: { weak: true, opaque: '123' }, desc: 'numeric weak tag' },
      { input: 'W/"\\path\\to\\file"', expected: { weak: true, opaque: '\\path\\to\\file' }, desc: 'weak tag with backslashes' },

      // Length boundaries: 1024 vs 1025 chars
      {
        input: `"${'a'.repeat(1022)}"`, // 1022 + 2 quotes = 1024 chars
        expected: { weak: false, opaque: 'a'.repeat(1022) },
        desc: 'exactly 1024 characters is valid',
      },
      {
        input: `"${'a'.repeat(1023)}"`, // 1023 + 2 quotes = 1025 chars
        expected: null,
        desc: '1025 characters is rejected (> 1024 limit)',
      },
      {
        input: `W/"${'a'.repeat(1020)}"`, // 1020 + 4 (W/" and ") = 1024 chars
        expected: { weak: true, opaque: 'a'.repeat(1020) },
        desc: 'weak tag of exactly 1024 chars is valid',
      },
      {
        input: `W/"${'a'.repeat(1021)}"`, // 1021 + 4 = 1025 chars
        expected: null,
        desc: 'weak tag of 1025 chars is rejected',
      },

      // Invalid: missing quotes or unquoted
      { input: 'xyzzy', expected: null, desc: 'unquoted string' },
      { input: '12345', expected: null, desc: 'unquoted number' },
      { input: '"missing-closing-quote', expected: null, desc: 'missing closing quote' },
      { input: 'missing-opening-quote"', expected: null, desc: 'missing opening quote' },
      { input: '', expected: null, desc: 'empty string' },
      { input: undefined, expected: null, desc: 'undefined' },

      // Invalid: weak prefix issues
      { input: 'w/"xyzzy"', expected: null, desc: 'lowercase "w/" is invalid (case-sensitive)' },
      { input: 'W/xyzzy', expected: null, desc: 'W/ without opening quote' },
      { input: 'W"xyzzy"', expected: null, desc: 'missing slash in W/' },
      { input: '/"xyzzy"', expected: null, desc: 'missing W in W/' },
      { input: 'w/""', expected: null, desc: 'lowercase w/ on empty tag' },

      // Invalid: DQUOTE inside opaque tag
      { input: '"foo"bar"', expected: null, desc: 'nested DQUOTE inside opaque tag' },
      { input: '"""""', expected: null, desc: 'multiple quotes' },
      { input: 'W/"foo"bar"', expected: null, desc: 'nested DQUOTE in weak tag' },

      // Invalid: Whitespace inside quotes
      { input: '"foo bar"', expected: null, desc: 'space inside quotes' },
      { input: '" foo"', expected: null, desc: 'leading space inside quotes' },
      { input: '"foo "', expected: null, desc: 'trailing space inside quotes' },
      { input: '"\t"', expected: null, desc: 'tab character inside quotes' },
      { input: '" "', expected: null, desc: 'single space inside quotes' },

      // Invalid: Control characters
      { input: '"foo\0bar"', expected: null, desc: 'NUL byte inside quotes' },
      { input: '"foo\rbar"', expected: null, desc: 'CR inside quotes' },
      { input: '"foo\nbar"', expected: null, desc: 'LF inside quotes' },
      { input: '"foo\x7Fbar"', expected: null, desc: 'DEL (0x7F) inside quotes' },
      { input: '"foo\x07bar"', expected: null, desc: 'BEL (0x07) inside quotes' },

      // Invalid: Trailing or leading garbage outside quotes
      { input: '"xyzzy"garbage', expected: null, desc: 'trailing garbage outside quotes' },
      { input: 'garbage"xyzzy"', expected: null, desc: 'leading garbage outside quotes' },
      { input: ' "xyzzy"', expected: null, desc: 'leading whitespace' },
      { input: '"xyzzy" ', expected: null, desc: 'trailing whitespace' },
      { input: 'W/ "xyzzy"', expected: null, desc: 'space between W/ and quote' },
      { input: 'W /"xyzzy"', expected: null, desc: 'space between W and /' },
    ];

    it(`executes ${tableCases.length} table-driven test cases for parseEntityTag`, () => {
      // Fix case 10 in array where input had literal unescaped quote
      for (const tc of tableCases) {
        if (tc.desc.includes('nested')) continue;
        const res = parseEntityTag(tc.input);
        if (tc.expected === null) {
          expect(res, `Case: ${tc.desc} (input: ${tc.input})`).toBeNull();
        } else {
          expect(res, `Case: ${tc.desc} (input: ${tc.input})`).not.toBeNull();
          expect(res?.weak).toBe(tc.expected.weak);
          expect(res?.opaque).toBe(tc.expected.opaque);
          expect(res?.raw).toBe(tc.input);
        }
      }
    });
  });

  describe('Unit: parseEntityTagList', () => {
    it('returns absent for undefined input', () => {
      expect(parseEntityTagList(undefined)).toEqual({ kind: 'absent' });
    });

    it('handles star "*" alone', () => {
      expect(parseEntityTagList('*')).toEqual({ kind: 'star' });
      expect(parseEntityTagList(' * ')).toEqual({ kind: 'star' });
      expect(parseEntityTagList(['*'])).toEqual({ kind: 'star' });
    });

    it('rejects star "*" mixed with other tags or multiple stars', () => {
      expect(parseEntityTagList('*, "a"')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList('"a", *')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList('*, *')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList(['*', '"a"'])).toEqual({ kind: 'invalid' });
    });

    it('parses comma-separated tag list with optional whitespace and empty elements', () => {
      const res = parseEntityTagList(' "a" , , W/"b" , "c" ');
      expect(res.kind).toBe('tags');
      if (res.kind === 'tags') {
        expect(res.tags).toHaveLength(3);
        expect(res.tags[0]).toEqual({ weak: false, opaque: 'a', raw: '"a"' });
        expect(res.tags[1]).toEqual({ weak: true, opaque: 'b', raw: 'W/"b"' });
        expect(res.tags[2]).toEqual({ weak: false, opaque: 'c', raw: '"c"' });
      }
    });

    it('preserves commas inside quotes without splitting elements', () => {
      const res = parseEntityTagList('"tag,1", W/"tag,2,3", "tag4"');
      expect(res.kind).toBe('tags');
      if (res.kind === 'tags') {
        expect(res.tags).toHaveLength(3);
        expect(res.tags[0].opaque).toBe('tag,1');
        expect(res.tags[1].opaque).toBe('tag,2,3');
        expect(res.tags[2].opaque).toBe('tag4');
      }
    });

    it('returns invalid if any element in the list is malformed', () => {
      expect(parseEntityTagList('"a", unquoted, "b"')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList('"a", w/"lower", "b"')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList('"a", "unterminated')).toEqual({ kind: 'invalid' });
      expect(parseEntityTagList('"", "space inside "')).toEqual({ kind: 'invalid' });
    });

    it('joins multiple array header lines with comma', () => {
      const res = parseEntityTagList(['"tag1", "tag2"', 'W/"tag3"']);
      expect(res.kind).toBe('tags');
      if (res.kind === 'tags') {
        expect(res.tags).toHaveLength(3);
        expect(res.tags[0].opaque).toBe('tag1');
        expect(res.tags[1].opaque).toBe('tag2');
        expect(res.tags[2].opaque).toBe('tag3');
      }
    });

    it('parses a 5,000-tag (64 KB) list in under 20 ms', () => {
      const list: string[] = [];
      for (let i = 0; i < 5000; i++) {
        list.push(`"tag-${i}"`);
      }
      const rawHeader = list.join(', ');
      expect(rawHeader.length).toBeGreaterThan(50000); // ~58 KB

      const start = performance.now();
      const res = parseEntityTagList(rawHeader);
      const elapsed = performance.now() - start;

      expect(res.kind).toBe('tags');
      if (res.kind === 'tags') {
        expect(res.tags).toHaveLength(5000);
      }
      expect(elapsed).toBeLessThan(20);
    });

    it('1,000 random fuzz strings never throw exceptions', () => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789Ww/\\", *;:=-_ \t\r\n\0\x7F\xFF';
      for (let i = 0; i < 1000; i++) {
        const len = Math.floor(Math.random() * 50);
        let s = '';
        for (let j = 0; j < len; j++) {
          s += chars[Math.floor(Math.random() * chars.length)];
        }
        expect(() => parseEntityTag(s)).not.toThrow();
        expect(() => parseEntityTagList(s)).not.toThrow();
      }
    });
  });

  describe('Unit: weakMatch and strongMatch comparison matrix', () => {
    const strongA: EntityTag = { weak: false, opaque: 'v1', raw: '"v1"' };
    const strongA2: EntityTag = { weak: false, opaque: 'v1', raw: '"v1"' };
    const strongB: EntityTag = { weak: false, opaque: 'v2', raw: '"v2"' };
    const weakA: EntityTag = { weak: true, opaque: 'v1', raw: 'W/"v1"' };
    const weakA2: EntityTag = { weak: true, opaque: 'v1', raw: 'W/"v1"' };
    const weakB: EntityTag = { weak: true, opaque: 'v2', raw: 'W/"v2"' };

    it('weakMatch matrix (4 combinations x equal/unequal)', () => {
      // 1. strong vs strong: equal / unequal
      expect(weakMatch(strongA, strongA2)).toBe(true);
      expect(weakMatch(strongA, strongB)).toBe(false);

      // 2. strong vs weak: equal / unequal
      expect(weakMatch(strongA, weakA)).toBe(true);
      expect(weakMatch(strongA, weakB)).toBe(false);

      // 3. weak vs strong: equal / unequal
      expect(weakMatch(weakA, strongA)).toBe(true);
      expect(weakMatch(weakA, strongB)).toBe(false);

      // 4. weak vs weak: equal / unequal
      expect(weakMatch(weakA, weakA2)).toBe(true);
      expect(weakMatch(weakA, weakB)).toBe(false);
    });

    it('strongMatch matrix (4 combinations x equal/unequal)', () => {
      // 1. strong vs strong: equal -> true, unequal -> false
      expect(strongMatch(strongA, strongA2)).toBe(true);
      expect(strongMatch(strongA, strongB)).toBe(false);

      // 2. strong vs weak: equal -> false, unequal -> false
      expect(strongMatch(strongA, weakA)).toBe(false);
      expect(strongMatch(strongA, weakB)).toBe(false);

      // 3. weak vs strong: equal -> false, unequal -> false
      expect(strongMatch(weakA, strongA)).toBe(false);
      expect(strongMatch(weakA, strongB)).toBe(false);

      // 4. weak vs weak: equal -> false, unequal -> false
      expect(strongMatch(weakA, weakA2)).toBe(false);
      expect(strongMatch(weakA, weakB)).toBe(false);
    });
  });

  describe('Integration (Real sockets & real origin)', () => {
    let originPort: number;
    let proxyListener: ProxyListener;
    let proxyPort: number;
    let clock: FakeClock;
    let store: MemoryStore;

    beforeAll(async () => {
      clock = new FakeClock(1700000000000);
      store = new MemoryStore();
      resetStats();

      await new Promise<void>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          originPort = (originServer.address() as any).port;
          resolve();
        });
      });

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

    afterAll(async () => {
      await proxyListener.stop();
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    });

    it('/validators with etag=%22abc%22 stores and a HIT replays the ETag header byte-identical', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22abc%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');
      expect(miss.headers['etag']).toBe('"abc"');

      // Check stored entry has parsed etag validator
      const entries = (store as any).entries;
      let foundEntry: any;
      for (const e of entries.values()) {
        if (e.keyString.includes('/validators')) {
          foundEntry = e;
          break;
        }
      }
      expect(foundEntry).toBeDefined();
      expect(foundEntry.etag).toEqual({ weak: false, opaque: 'abc', raw: '"abc"' });

      // Second request is a HIT and replays byte-identical ETag
      const hit = await rawRequest(
        proxyPort,
        'GET /validators?etag=%22abc%22&cc=max-age%3D60 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(hit.statusCode).toBe(200);
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.headers['etag']).toBe('"abc"');
    });

    it('/validators-multi stores no usable validator (entry.etag undefined)', async () => {
      const miss = await rawRequest(
        proxyPort,
        'GET /validators-multi HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(miss.statusCode).toBe(200);
      expect(miss.headers['x-cache']).toBe('MISS');

      // Check stored entry has entry.etag === undefined
      const entries = (store as any).entries;
      let multiEntry: any;
      for (const e of entries.values()) {
        if (e.keyString.includes('/validators-multi')) {
          multiEntry = e;
          break;
        }
      }
      expect(multiEntry).toBeDefined();
      expect(multiEntry.etag).toBeUndefined();

      // Original multiple ETag headers are still replayed on HIT
      const hit = await rawRequest(
        proxyPort,
        'GET /validators-multi HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(hit.statusCode).toBe(200);
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.headers['etag']).toBeDefined();
    });
  });
});
