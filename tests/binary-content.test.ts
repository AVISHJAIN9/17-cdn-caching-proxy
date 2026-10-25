import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { createAndStartProxy } from '../src/proxy/index.js';
import { ProxyListener } from '../src/proxy/listener.js';
import { MemoryStore } from '../src/cache/memory-store.js';

describe('Feature 78: Binary content', { timeout: 20000 }, () => {
  let originServer: http.Server;
  let proxy: ProxyListener;
  let originPort: number;
  let proxyPort: number;
  let originRequests = 0;
  let store: MemoryStore;

  // Generate a 64KB binary buffer containing all byte values (0x00 to 0xFF) and non-UTF8 sequences
  const rawBinaryData = Buffer.alloc(65536);
  for (let i = 0; i < rawBinaryData.length; i++) {
    rawBinaryData[i] = i % 256;
  }
  const rawBinarySha256 = crypto.createHash('sha256').update(rawBinaryData).digest('hex');

  // Simulated PNG buffer with valid magic header
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngData = Buffer.concat([pngHeader, crypto.randomBytes(4096)]);
  const pngSha256 = crypto.createHash('sha256').update(pngData).digest('hex');

  // Simulated MP4 video buffer
  const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const mp4Data = Buffer.concat([mp4Header, crypto.randomBytes(8192)]);
  const mp4Sha256 = crypto.createHash('sha256').update(mp4Data).digest('hex');

  beforeEach(async () => {
    originRequests = 0;

    originServer = http.createServer((req, res) => {
      originRequests++;

      if (req.url === '/binary-octet-stream') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': rawBinaryData.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(rawBinaryData);
        return;
      }

      if (req.url === '/image.png') {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': pngData.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(pngData);
        return;
      }

      if (req.url === '/video.mp4') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': mp4Data.length.toString(),
          'Cache-Control': 'public, max-age=3600',
          'ETag': '"mp4-v1"',
        });
        res.end(mp4Data);
        return;
      }

      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    originPort = (originServer.address() as AddressInfo).port;

    store = new MemoryStore({
      maxObjectBytes: 5 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 1000,
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      cache: {
        enabled: true,
        debugHeaders: true,
        range: true,
      },
      compression: { enabled: true }, // Verify compression safely bypasses binary data
    });

    proxyPort = proxy.httpPort!;
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (originServer) {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
    }
  });

  it('preserves bit-identical arbitrary binary octet stream across MISS and HIT', async () => {
    // 1. Initial request (Cache MISS)
    const res1 = await fetch(`http://127.0.0.1:${proxyPort}/binary-octet-stream`, {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('content-type')).toBe('application/octet-stream');
    expect(res1.headers.get('x-cache')).toBe('MISS');
    const arrayBuffer1 = await res1.arrayBuffer();
    const received1 = Buffer.from(arrayBuffer1);
    expect(received1.length).toBe(rawBinaryData.length);
    expect(crypto.createHash('sha256').update(received1).digest('hex')).toBe(rawBinarySha256);
    expect(Buffer.compare(rawBinaryData, received1)).toBe(0);
    expect(originRequests).toBe(1);

    // 2. Second request (Cache HIT)
    const res2 = await fetch(`http://127.0.0.1:${proxyPort}/binary-octet-stream`, {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('content-type')).toBe('application/octet-stream');
    expect(res2.headers.get('x-cache')).toBe('HIT');
    const arrayBuffer2 = await res2.arrayBuffer();
    const received2 = Buffer.from(arrayBuffer2);
    expect(received2.length).toBe(rawBinaryData.length);
    expect(crypto.createHash('sha256').update(received2).digest('hex')).toBe(rawBinarySha256);
    expect(Buffer.compare(rawBinaryData, received2)).toBe(0);
    expect(originRequests).toBe(1);
  });

  it('serves binary image and video with exact byte integrity and correct headers', async () => {
    // PNG
    const pngRes = await fetch(`http://127.0.0.1:${proxyPort}/image.png`);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-type')).toBe('image/png');
    const receivedPng = Buffer.from(await pngRes.arrayBuffer());
    expect(crypto.createHash('sha256').update(receivedPng).digest('hex')).toBe(pngSha256);
    expect(Buffer.compare(pngData, receivedPng)).toBe(0);

    // MP4 Video
    const mp4Res = await fetch(`http://127.0.0.1:${proxyPort}/video.mp4`);
    expect(mp4Res.status).toBe(200);
    expect(mp4Res.headers.get('content-type')).toBe('video/mp4');
    const receivedMp4 = Buffer.from(await mp4Res.arrayBuffer());
    expect(crypto.createHash('sha256').update(receivedMp4).digest('hex')).toBe(mp4Sha256);
    expect(Buffer.compare(mp4Data, receivedMp4)).toBe(0);
  });

  it('serves partial range requests from cached binary video correctly', async () => {
    // Prime the cache
    await fetch(`http://127.0.0.1:${proxyPort}/video.mp4`);
    expect(originRequests).toBe(1);

    // Request byte range 100-499 (400 bytes)
    const rangeRes = await fetch(`http://127.0.0.1:${proxyPort}/video.mp4`, {
      headers: { Range: 'bytes=100-499' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe(`bytes 100-499/${mp4Data.length}`);
    expect(rangeRes.headers.get('content-length')).toBe('400');
    expect(rangeRes.headers.get('x-cache')).toBe('HIT');

    const sliceReceived = Buffer.from(await rangeRes.arrayBuffer());
    expect(sliceReceived.length).toBe(400);
    const expectedSlice = mp4Data.subarray(100, 500);
    expect(Buffer.compare(expectedSlice, sliceReceived)).toBe(0);
    expect(originRequests).toBe(1); // Served entirely from cache
  });
});
