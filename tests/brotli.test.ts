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

describe('Feature 67: Brotli compression & decompression', () => {
  describe('Buffer & Streaming Round-trip Fidelity', () => {
    it('round-trips an empty body (0 bytes)', async () => {
      const empty = Buffer.alloc(0);
      const compressed = await compressBuffer(empty, 'br');
      const decompressed = await decompressBuffer(compressed, 'br');
      expect(decompressed.length).toBe(0);
    });

    it('round-trips a 1-byte body', async () => {
      const oneByte = Buffer.from('b');
      const compressed = await compressBuffer(oneByte, 'br');
      const decompressed = await decompressBuffer(compressed, 'br');
      expect(decompressed.toString()).toBe('b');
    });

    it('round-trips a 64KB body with odd chunk splits', async () => {
      const data = Buffer.from('BrotliHighCompressionStreamDataFixture9876543210'.repeat(1600)); // >64KB
      expect(data.length).toBeGreaterThan(64 * 1024);

      const oddChunks: Buffer[] = [];
      let offset = 0;
      const step = 43;
      while (offset < data.length) {
        oddChunks.push(data.subarray(offset, Math.min(offset + step, data.length)));
        offset += step;
      }

      const oddReadable = Readable.from(oddChunks);
      const compressor = createCompressor('br');
      const decompressor = createDecompressor('br');
      const sink = new BufferCollector();

      await pipeline(oddReadable, compressor, decompressor, sink);
      const reconstructed = Buffer.concat(sink.chunks);
      expect(reconstructed.equals(data)).toBe(true);
    });

    it('streams a 10MB body with bounded peak memory growth', async () => {
      const totalChunks = 160; // 10MB total
      const chunkPattern = Buffer.from('Brotli streaming test chunk payload line for memory limits. '.repeat(1100)); // ~64KB

      async function* generate10MB() {
        for (let i = 0; i < totalChunks; i++) {
          yield chunkPattern;
        }
      }

      const initialMemory = process.memoryUsage().heapUsed;
      const compressor = createCompressor('br');
      const decompressor = createDecompressor('br');
      const sink = new BufferCollector();

      await pipeline(Readable.from(generate10MB()), compressor, decompressor, sink);
      const receivedBytes = sink.chunks.reduce((acc, c) => acc + c.length, 0);
      expect(receivedBytes).toBe(totalChunks * chunkPattern.length);

      const finalMemory = process.memoryUsage().heapUsed;
      const heapGrowthMB = (finalMemory - initialMemory) / (1024 * 1024);
      expect(heapGrowthMB).toBeLessThan(40);
    });
  });

  describe('Error Handling, Corrupt Streams, Aborts & Decompression Bomb Limit', () => {
    it('produces a defined error on a corrupt brotli stream without hanging or crashing', async () => {
      const corruptData = Buffer.from([0x5b, 0xff, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
      const decompressor = createDecompressor('br');
      const sink = new BufferCollector();

      await expect(pipeline(Readable.from([corruptData]), decompressor, sink)).rejects.toThrow();
    });

    it('releases codec resources cleanly when stream is aborted mid-compression', async () => {
      const compressor = createCompressor('br');
      compressor.on('error', () => {});
      let destroyed = false;
      compressor.on('close', () => {
        destroyed = true;
      });

      compressor.write(Buffer.from('hello brotli chunk'));
      compressor.destroy(new Error('Client aborted'));

      await new Promise((r) => setImmediate(r));
      expect(compressor.destroyed).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('cuts off cleanly and returns defined error on a decompression bomb stream exceeding limit', async () => {
      const zeroes = Buffer.alloc(10 * 1024 * 1024, 0);
      const compressedBomb = zlib.brotliCompressSync(zeroes);

      const strictDecompressor = createDecompressor('br', { maxDecompressedBytes: 1024 * 1024 });
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

  describe('End-to-End Proxy Brotli Integration', () => {
    let originServer: http.Server;
    let proxy: any;

    afterEach(async () => {
      if (proxy) await proxy.stop();
      if (originServer) {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      }
    });

    it('compresses uncompressed origin response when client accepts br, setting Content-Encoding: br', async () => {
      const sampleText = 'This is compressible text content repeated for Brotli testing. '.repeat(100);
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
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/br-test`, {
        headers: { 'Accept-Encoding': 'br' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe('br');
      expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
      const text = await res.text();
      expect(text).toBe(sampleText);

      // 2. Fetch raw wire bytes via node:http to assert actual wire bytes are valid brotli
      const rawWireBytes = await new Promise<Buffer>((resolve, reject) => {
        http.get(
          `http://127.0.0.1:${proxy.httpPort}/br-test`,
          { headers: { 'Accept-Encoding': 'br' } },
          (rawRes) => {
            const chunks: Buffer[] = [];
            rawRes.on('data', (c) => chunks.push(c));
            rawRes.on('end', () => resolve(Buffer.concat(chunks)));
            rawRes.on('error', reject);
          }
        ).on('error', reject);
      });

      const decompressed = zlib.brotliDecompressSync(rawWireBytes).toString();
      expect(decompressed).toBe(sampleText);
    });

    it('decompresses origin brotli response and serves identity when client does not accept br', async () => {
      const sampleText = 'Origin pre-compressed brotli payload for identity test.'.repeat(50);
      const preBrotlied = zlib.brotliCompressSync(Buffer.from(sampleText));

      originServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'br',
          'Content-Length': preBrotlied.length,
        });
        res.end(preBrotlied);
      });
      await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
      const originPort = (originServer.address() as any).port;

      proxy = await createAndStartProxy({
        httpHost: '127.0.0.1',
        httpPort: 0,
        originUrl: `http://127.0.0.1:${originPort}`,
      });

      // Client explicitly refuses br or only accepts identity
      const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/identity-test`, {
        headers: { 'Accept-Encoding': 'identity, br;q=0' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBeNull();
      const text = await res.text();
      expect(text).toBe(sampleText);
    });
  });
});
