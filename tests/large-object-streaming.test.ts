import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import { LargeObjectManager } from '../src/cache/large-object.js';

describe('Feature 149: Large-Object Streaming', () => {
  let tempDir: string;
  let cacheDir: string;
  let manager: LargeObjectManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-temp-'));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-cache-'));
    manager = new LargeObjectManager({
      tempDir,
      cacheDir,
      maxMemoryObjectBytes: 1024 * 1024, // 1 MB
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('streams synthetic large payload with bounded memory and publishes atomically', async () => {
    const keyHash = 'large-object-hash-1';
    const chunkSize = 64 * 1024; // 64 KB
    const totalChunks = 160; // 10 MB total for fast deterministic test
    const expectedTotal = chunkSize * totalChunks;

    const initialRss = process.memoryUsage().rss;

    // Upstream stream generator without materializing entire body in memory
    let emitted = 0;
    const upstream = new Readable({
      read() {
        if (emitted >= totalChunks) {
          this.push(null);
        } else {
          this.push(Buffer.alloc(chunkSize, 0x41)); // 'A'
          emitted++;
        }
      },
    });

    const clientStream = new PassThrough();
    let clientReceived = 0;
    clientStream.on('data', (c) => {
      clientReceived += c.length;
    });

    const { promise } = manager.streamTeeToDisk({
      keyHash,
      upstreamStream: upstream,
      downstreamClient: clientStream,
      contentLength: expectedTotal,
      etag: '"v1"',
    });

    const meta = await promise;
    expect(meta.contentLength).toBe(expectedTotal);
    expect(meta.completed).toBe(true);
    expect(clientReceived).toBe(expectedTotal);
    expect(fs.existsSync(meta.filePath)).toBe(true);

    // Assert memory growth was bounded well under 64 MB
    const finalRss = process.memoryUsage().rss;
    const rssGrowthMb = (finalRss - initialRss) / (1024 * 1024);
    expect(rssGrowthMb).toBeLessThan(64);
  });

  it('aborts cleanly and deletes temp file on upstream error', async () => {
    const keyHash = 'aborted-upstream';
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const client = new PassThrough();
    client.on('error', () => {});

    const { promise } = manager.streamTeeToDisk({
      keyHash,
      upstreamStream: upstream,
      downstreamClient: client,
      contentLength: 10000,
    });

    upstream.write(Buffer.alloc(100, 0x42));
    upstream.destroy(new Error('Upstream socket hang up'));

    await expect(promise).rejects.toThrow('Upstream socket hang up');
    expect(manager.getPublished(keyHash)).toBeUndefined();

    // Temp dir must be empty
    const tempFiles = fs.readdirSync(tempDir);
    expect(tempFiles.length).toBe(0);
  });

  it('handles slow client policy detach: client aborts but cache fill completes', async () => {
    const detachManager = new LargeObjectManager({
      tempDir,
      cacheDir,
      slowClientPolicy: 'detach',
    });

    const keyHash = 'detach-client-test';
    const upstream = new PassThrough();
    const client = new PassThrough();

    const { promise } = detachManager.streamTeeToDisk({
      keyHash,
      upstreamStream: upstream,
      downstreamClient: client,
      contentLength: 200,
    });

    upstream.write(Buffer.alloc(50, 0x43));
    // Client disconnects mid-stream
    client.destroy();

    // Upstream finishes writing
    upstream.write(Buffer.alloc(150, 0x43));
    upstream.end();

    const meta = await promise;
    expect(meta.contentLength).toBe(200);
    expect(meta.completed).toBe(true);
    expect(fs.existsSync(meta.filePath)).toBe(true);
  });

  it('serves Range requests accurately from published large object', async () => {
    const keyHash = 'range-test-object';
    const body = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const upstream = Readable.from([body]);
    const client = new PassThrough();

    const { promise } = manager.streamTeeToDisk({
      keyHash,
      upstreamStream: upstream,
      downstreamClient: client,
      contentLength: body.length,
      etag: '"range-etag"',
    });

    await promise;

    // Read range 10-19
    const rangeStream = manager.createRangeStream(keyHash, 10, 19, '"range-etag"');
    const chunks: Buffer[] = [];
    for await (const chunk of rangeStream) {
      chunks.push(Buffer.from(chunk));
    }
    const rangeData = Buffer.concat(chunks).toString();
    expect(rangeData).toBe('ABCDEFGHIJ');
  });

  it('discards stale partial large object on validator mismatch', async () => {
    const keyHash = 'stale-validator';
    const upstream = Readable.from([Buffer.from('original data')]);
    const client = new PassThrough();

    const { promise } = manager.streamTeeToDisk({
      keyHash,
      upstreamStream: upstream,
      downstreamClient: client,
      contentLength: 13,
      etag: '"v1"',
    });

    const meta = await promise;
    expect(fs.existsSync(meta.filePath)).toBe(true);

    // Update with mismatched ETag -> discards stale object
    manager.updateRange(keyHash, { start: 13, end: 50 }, '"v2"');
    expect(manager.getPublished(keyHash)).toBeUndefined();
    expect(fs.existsSync(meta.filePath)).toBe(false);
  });
});
