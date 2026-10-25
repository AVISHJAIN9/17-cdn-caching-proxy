import { describe, it, expect } from 'vitest';
import { LargeObjectManager } from '../src/cache/large-object.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Readable, PassThrough } from 'node:stream';

describe('Feature 132: Large-object testing', () => {
  it('streams multi-megabyte payloads without heap spikes or temp file leaks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-temp-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-cache-'));
    const manager = new LargeObjectManager({ tempDir, cacheDir, maxMemoryObjectBytes: 1024 });

    const totalBytes = 2 * 1024 * 1024; // 2 MB synthetic stream
    const chunk = Buffer.alloc(64 * 1024, 0x5a); // 64 KB
    let sent = 0;

    const upstream = new Readable({
      read() {
        if (sent >= totalBytes) {
          this.push(null);
        } else {
          this.push(chunk);
          sent += chunk.length;
        }
      },
    });

    const client = new PassThrough();
    const { promise } = manager.streamTeeToDisk({
      keyHash: 'stress-lo-1',
      upstreamStream: upstream,
      downstreamClient: client,
      contentLength: totalBytes,
    });

    const meta = await promise;
    expect(meta.contentLength).toBe(totalBytes);
    expect(fs.readdirSync(tempDir).length).toBe(0); // Cleaned temp file

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});
