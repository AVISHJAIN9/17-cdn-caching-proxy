import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createCompressor,
  createDecompressor,
  compressBuffer,
  decompressBuffer,
} from '../src/compression/codecs.js';
import { createAndStartProxy } from '../src/proxy/index.js';

class BufferCollector extends Writable {
  public readonly chunks: Buffer[] = [];
  _write(chunk: any, _enc: BufferEncoding, callback: (err?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

describe('Feature 66: Gzip compression & decompression', () => {
  describe('Buffer & Streaming Round-trip Fidelity', () => {
    it('round-trips an empty body (0 bytes)', async () => {
      const empty = Buffer.alloc(0);
      const compressed = await compressBuffer(empty, 'gzip');
      const decompressed = await decompressBuffer(compressed, 'gzip');
      expect(decompressed.length).toBe(0);
    });

    it('round-trips a 1-byte body', async () => {
      const oneByte = Buffer.from('x');
      const compressed = await compressBuffer(oneByte, 'gzip');
      const decompressed = await decompressBuffer(compressed, 'gzip');
      expect(decompressed.toString()).toBe('x');
    });

    it('round-trips a 64KB body with odd chunk splits', async () => {
      const data = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(2000)); // >64KB
      expect(data.length).toBeGreaterThan(64 * 1024);

      // Create readable with odd chunk sizes (e.g. 7 bytes, 13 bytes, 31 bytes)
      const oddChunks: Buffer[] = [];
      let offset = 0;
      const step = 37;
      while (offset < data.length) {
        oddChunks.push(data.subarray(offset, Math.min(offset + step, data.length)));
        offset += step;
      }

      const oddReadable = Readable.from(oddChunks);
      const gzipStream = createCompressor('gzip');
      const gunzipStream = createDecompressor('gzip');
      const sink = new BufferCollector();

      await pipeline(oddReadable, gzipStream, gunzipStream, sink);
      const reconstructed = Buffer.concat(sink.chunks);
      expect(reconstructed.equals(data)).toBe(true);
    });

    it('streams a 10MB body with bounded peak memory growth', async () => {
      const totalChunks = 160; // 10MB total
      const chunkPattern = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(1450)); // ~64KB

      async function* generate10MB() {
        for (let i = 0; i < totalChunks; i++) {
          yield chunkPattern;
        }
      }

      const initialMemory = process.memoryUsage().heapUsed;
      const compressor = createCompressor('gzip');
      const decompressor = createDecompressor('gzip');
      const sink = new BufferCollector();

      await pipeline(Readable.from(generate10MB()), compressor, decompressor, sink);
      const receivedBytes = sink.chunks.reduce((acc, c) => acc + c.length, 0);
      expect(receivedBytes).toBe(totalChunks * chunkPattern.length);

      const finalMemory = process.memoryUsage().heapUsed;
      const heapGrowthMB = (finalMemory - initialMemory) / (1024 * 1024);
      // Because streaming processes chunks iteratively rather than buffering all 10MB + compressed in heap,
      // heap growth should stay well within a reasonable bound (e.g. < 40MB)
      expect(heapGrowthMB).toBeLessThan(40);
    });
  });

  describe('Error Handling, Corrupt Streams, Aborts & Decompression Bomb Limit', () => {
    it('produces a defined error on a corrupt compressed stream, without hanging or crashing', async () => {
      const corruptData = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0xff, 0xff]);
      const decompressor = createDecompressor('gzip');
      const sink = new BufferCollector();

      await expect(pipeline(Readable.from([corruptData]), decompressor, sink)).rejects.toThrow();
    });

    it('releases codec resources cleanly when stream is aborted mid-compression', async () => {
      const compressor = createCompressor('gzip');
      compressor.on('error', () => {}); // Handle expected error from abort
      let destroyed = false;
      compressor.on('close', () => {
        destroyed = true;
      });

      compressor.write(Buffer.from('hello chunk 1'));
      compressor.destroy(new Error('Client aborted'));

      await new Promise((r) => setImmediate(r));
      expect(compressor.destroyed).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('cuts off cleanly and returns defined error on a decompression bomb stream exceeding limit', async () => {
      // 10MB of zeroes compresses to just ~10KB gzip
      const zeroes = Buffer.alloc(10 * 1024 * 1024, 0);
      const compressedBomb = zlib.gzipSync(zeroes);

      // Enforce a strict maxDecompressedBytes limit of 1MB
      const strictDecompressor = createDecompressor('gzip', { maxDecompressedBytes: 1024 * 1024 });
      const sink = new BufferCollector();

      let errorCaught: any = null;
      try {
        await pipeline(Readable.from([compressedBomb]), strictDecompressor, sink);
      } catch (err) {
        errorCaught = err;
      }

      expect(errorCaught).toBeDefined();
      expect(errorCaught.message).toMatch(/DECOMPRESSION_BOMB_DETECTED/i);
    });
  });

  describe('End-to-End Proxy Gzip Integration', () => {
    let originServer: http.Server;
    let proxy: any;

    afterEach(async () => {
      if (proxy) await proxy.stop();
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });

    it('compresses uncompressed origin response when client accepts gzip, setting Content-Encoding: gzip', async () => {
      const sampleText = 'This is compressible text content repeated. '.repeat(100);
      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(sampleText),
        });
        res.end(sampleText);
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      const originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });

      // 1. Fetch with standard fetch verifies headers and automatic decompression
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/gzip-test`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe('gzip');
      expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
      const text = await res.text();
      expect(text).toBe(sampleText);

      // 2. Fetch raw wire bytes via node:http to assert actual wire bytes are valid gzip
      const rawWireBytes = await new Promise<Buffer>((resolve, reject) => {
        http.get(
          `http://127.0.0.1:${proxy.httpPort}/gzip-test`,
          { headers: { 'Accept-Encoding': 'gzip' } },
          (rawRes) => {
            const chunks: Buffer[] = [];
            rawRes.on('data', (c) => chunks.push(c));
            rawRes.on('end', () => resolve(Buffer.concat(chunks)));
            rawRes.on('error', reject);
          }
        ).on('error', reject);
      });

      const decompressed = zlib.gunzipSync(rawWireBytes).toString();
      expect(decompressed).toBe(sampleText);
    });

    it('decompresses origin gzip response and serves identity when client does not accept gzip', async () => {
      const sampleText = 'Origin pre-compressed gzip payload for identity test.'.repeat(50);
      const preGzipped = zlib.gzipSync(Buffer.from(sampleText));

      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'gzip',
          'Content-Length': preGzipped.length,
        });
        res.end(preGzipped);
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      const originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });

      // Client explicitly refuses gzip or only accepts identity
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/identity-test`, {
        headers: { 'Accept-Encoding': 'identity, gzip;q=0' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBeNull(); // identity has no Content-Encoding header
      const text = await res.text();
      expect(text).toBe(sampleText);
    });
  });
});
