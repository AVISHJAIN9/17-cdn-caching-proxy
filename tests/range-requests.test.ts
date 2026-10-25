import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { parseRangeHeader, evaluateIfRange } from '../src/range/parse-range.js';

describe('Feature 74: Range requests', () => {
  describe('Unit: parseRangeHeader & evaluateIfRange', () => {
    const total = 1000;

    it('parses closed byte ranges correctly', () => {
      const res = parseRangeHeader('bytes=0-499', total);
      expect(res).toEqual({
        type: 'valid',
        ranges: [{ start: 0, end: 499, length: 500 }],
      });
    });

    it('parses open-ended byte ranges correctly', () => {
      const res = parseRangeHeader('bytes=500-', total);
      expect(res).toEqual({
        type: 'valid',
        ranges: [{ start: 500, end: 999, length: 500 }],
      });
    });

    it('parses suffix byte ranges correctly', () => {
      const res = parseRangeHeader('bytes=-200', total);
      expect(res).toEqual({
        type: 'valid',
        ranges: [{ start: 800, end: 999, length: 200 }],
      });
    });

    it('clamps end to total - 1 when end exceeds length', () => {
      const res = parseRangeHeader('bytes=900-5000', total);
      expect(res).toEqual({
        type: 'valid',
        ranges: [{ start: 900, end: 999, length: 100 }],
      });
    });

    it('clamps suffix range to 0 when suffix exceeds total length', () => {
      const res = parseRangeHeader('bytes=-1500', total);
      expect(res).toEqual({
        type: 'valid',
        ranges: [{ start: 0, end: 999, length: 1000 }],
      });
    });

    it('returns unsatisfiable when start >= total', () => {
      const res = parseRangeHeader('bytes=1000-1500', total);
      expect(res).toEqual({ type: 'unsatisfiable', total });
    });

    it('returns unsatisfiable for suffix length 0', () => {
      const res = parseRangeHeader('bytes=-0', total);
      expect(res).toEqual({ type: 'unsatisfiable', total });
    });

    it('returns malformed for invalid units or syntax', () => {
      expect(parseRangeHeader('items=0-10', total)).toEqual({ type: 'malformed' });
      expect(parseRangeHeader('bytes=abc-def', total)).toEqual({ type: 'malformed' });
      expect(parseRangeHeader('bytes=500-100', total)).toEqual({ type: 'malformed' });
      expect(parseRangeHeader('bytes=', total)).toEqual({ type: 'malformed' });
      expect(parseRangeHeader('', total)).toEqual({ type: 'none' });
      expect(parseRangeHeader(undefined, total)).toEqual({ type: 'none' });
    });

    it('evaluates If-Range with strong ETag matching', () => {
      expect(evaluateIfRange('"etag-123"', '"etag-123"', undefined)).toBe(true);
      expect(evaluateIfRange('"etag-123"', '"different"', undefined)).toBe(false);
      // Weak ETag in If-Range MUST NOT match per RFC 9110 §13.1.5
      expect(evaluateIfRange('W/"etag-123"', 'W/"etag-123"', undefined)).toBe(false);
    });

    it('evaluates If-Range with Last-Modified dates', () => {
      const mod = 'Wed, 21 Oct 2026 07:28:00 GMT';
      const same = 'Wed, 21 Oct 2026 07:28:00 GMT';
      const newer = 'Wed, 21 Oct 2026 08:00:00 GMT';
      const older = 'Wed, 21 Oct 2026 06:00:00 GMT';

      expect(evaluateIfRange(same, undefined, mod)).toBe(true);
      expect(evaluateIfRange(newer, undefined, mod)).toBe(true);
      expect(evaluateIfRange(older, undefined, mod)).toBe(false);
    });
  });

  describe('Integration: Range requests through CdnProxy', () => {
    let originServer: http.Server;
    let proxy: ProxyListener;
    let originPort: number;
    let proxyPort: number;
    const bodyContent = '0123456789'.repeat(100); // 1000 bytes

    beforeEach(async () => {
      originServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('ETag', '"range-test-v1"');
        res.setHeader('Last-Modified', 'Wed, 21 Oct 2026 07:28:00 GMT');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');

        // Check if origin received Range and evaluate If-Range
        if (req.headers['range']) {
          const ifRange = req.headers['if-range'] as string | undefined;
          const ifRangeMatches = evaluateIfRange(ifRange, '"range-test-v1"', 'Wed, 21 Oct 2026 07:28:00 GMT');
          if (ifRangeMatches) {
            const parsed = parseRangeHeader(req.headers['range'] as string, Buffer.byteLength(bodyContent));
            if (parsed.type === 'valid') {
              const r = parsed.ranges[0];
              res.statusCode = 206;
              res.setHeader('Content-Range', `bytes ${r.start}-${r.end}/${Buffer.byteLength(bodyContent)}`);
              const chunk = Buffer.from(bodyContent).subarray(r.start, r.end + 1);
              res.setHeader('Content-Length', chunk.length);
              res.end(chunk);
              return;
            } else if (parsed.type === 'unsatisfiable') {
              res.statusCode = 416;
              res.setHeader('Content-Range', `bytes */${Buffer.byteLength(bodyContent)}`);
              res.end();
              return;
            }
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', Buffer.byteLength(bodyContent));
        res.end(bodyContent);
      });

      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      originPort = (originServer.address() as AddressInfo).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
        compression: { enabled: false }, // focus on range requests
      });

      proxyPort = proxy.httpPort!;
    });

    afterEach(async () => {
      if (proxy) await proxy.stop();
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });

    it('returns 206 Partial Content for valid closed range', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: { Range: 'bytes=0-9' },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-9/1000');
      expect(res.headers.get('content-length')).toBe('10');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      const text = await res.text();
      expect(text).toBe('0123456789');
    });

    it('returns 206 Partial Content for open-ended range', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: { Range: 'bytes=990-' },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
      expect(res.headers.get('content-length')).toBe('10');
      const text = await res.text();
      expect(text).toBe('0123456789');
    });

    it('returns 206 Partial Content for suffix range', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: { Range: 'bytes=-10' },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
      expect(res.headers.get('content-length')).toBe('10');
      const text = await res.text();
      expect(text).toBe('0123456789');
    });

    it('returns 416 Range Not Satisfiable for out of bounds range', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: { Range: 'bytes=2000-3000' },
      });

      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */1000');
    });

    it('fulfills range when If-Range matches entity tag', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: {
          Range: 'bytes=0-4',
          'If-Range': '"range-test-v1"',
        },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-4/1000');
      const text = await res.text();
      expect(text).toBe('01234');
    });

    it('serves full 200 OK when If-Range validator does not match', async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
        headers: {
          Range: 'bytes=0-4',
          'If-Range': '"stale-etag-xyz"',
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-range')).toBeNull();
      const text = await res.text();
      expect(text).toBe(bodyContent);
    });
  });
});
