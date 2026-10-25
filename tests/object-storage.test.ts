import { describe, it, expect } from 'vitest';
import { ObjectStore } from '../src/cache/object-store.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { CacheEntry } from '../src/cache/store.js';

function createDummyEntry(keyHash: string, body: Buffer): CacheEntry {
  return {
    keyHash,
    keyString: `GET https://example.com/${keyHash}`,
    originId: 'origin-1',
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/octet-stream' },
    body,
    size: body.byteLength,
    storedAt: 1000,
    hitCount: 0,
    lastAccessedAt: 1000,
    requestTimeMs: 990,
    responseTimeMs: 1000,
    dateValueMs: 1000,
    ageValueSeconds: 0,
    freshnessLifetimeMs: 60000,
    lifetimeSource: 'max-age',
  };
}

describe('Feature 31: Object storage', () => {
  describe('Byte-accurate size accounting', () => {
    it('maintains exact totalByte count through insert, overwrite, delete, and eviction', () => {
      const store = new ObjectStore();
      expect(store.totalBytes).toBe(0);

      // 1. Insert 3 entries
      const b1 = Buffer.from('hello 1'); // 7 bytes
      const b2 = Buffer.from('larger chunk of data here'); // 25 bytes
      const b3 = Buffer.from('third body item'); // 15 bytes

      store.put('key-1', b1);
      expect(store.totalBytes).toBe(7);
      expect(store.sumLiveBytes()).toBe(7);

      store.put('key-2', b2);
      expect(store.totalBytes).toBe(7 + 25);
      expect(store.sumLiveBytes()).toBe(32);

      store.put('key-3', b3);
      expect(store.totalBytes).toBe(7 + 25 + 15);
      expect(store.sumLiveBytes()).toBe(47);

      // 2. Overwrite key-1 with larger body (replacement releases old bytes)
      const b1Replacement = Buffer.from('hello 1 replacement that is much longer'); // 39 bytes
      const resOverwrite = store.put('key-1', b1Replacement);
      expect(resOverwrite.replacedSize).toBe(7);
      expect(resOverwrite.size).toBe(39);
      expect(store.totalBytes).toBe(39 + 25 + 15);
      expect(store.sumLiveBytes()).toBe(store.totalBytes);

      // 3. Overwrite key-2 with smaller body
      const b2Small = Buffer.from('tiny'); // 4 bytes
      store.put('key-2', b2Small);
      expect(store.totalBytes).toBe(39 + 4 + 15);
      expect(store.sumLiveBytes()).toBe(store.totalBytes);

      // 4. Delete key-3 (releases bytes)
      const released = store.delete('key-3');
      expect(released).toBe(15);
      expect(store.totalBytes).toBe(39 + 4);
      expect(store.sumLiveBytes()).toBe(store.totalBytes);

      // 5. Deleting non-existent key releases 0 bytes
      expect(store.delete('missing-key')).toBe(0);
      expect(store.totalBytes).toBe(39 + 4);

      // 6. Clear releases everything
      store.clear();
      expect(store.totalBytes).toBe(0);
      expect(store.sumLiveBytes()).toBe(0);
      expect(store.count).toBe(0);
    });

    it('coordinates with MemoryStore to keep stats().totalBytes exactly equal to sum of live bodies', () => {
      const memoryStore = new MemoryStore();
      const e1 = createDummyEntry('e1', Buffer.alloc(120, 'a'));
      const e2 = createDummyEntry('e2', Buffer.alloc(340, 'b'));

      memoryStore.set(e1);
      memoryStore.set(e2);
      expect(memoryStore.stats().totalBytes).toBe(460);
      expect(memoryStore.getObjectStore().totalBytes).toBe(460);
      expect(memoryStore.getObjectStore().sumLiveBytes()).toBe(460);

      // Overwrite e1 with 50 bytes
      const e1New = createDummyEntry('e1', Buffer.alloc(50, 'c'));
      memoryStore.set(e1New);
      expect(memoryStore.stats().totalBytes).toBe(390);
      expect(memoryStore.getObjectStore().sumLiveBytes()).toBe(390);

      // Delete e2
      memoryStore.delete('e2');
      expect(memoryStore.stats().totalBytes).toBe(50);
      expect(memoryStore.getObjectStore().sumLiveBytes()).toBe(50);
    });
  });

  describe('Streaming-safe reads during concurrent eviction/replacement', () => {
    it('does not corrupt or truncate in-flight stream when body is deleted or evicted mid-stream', async () => {
      const store = new ObjectStore();
      const largePayload = Buffer.alloc(500 * 1024, 0x42); // 500 KB
      store.put('stream-key', largePayload);

      // Open a read stream
      const stream = store.getStream('stream-key', { chunkSize: 16 * 1024 });
      expect(stream).toBeDefined();

      const chunks: Buffer[] = [];

      // Read first chunk, then delete from store while reading is in-flight
      await new Promise<void>((resolve, reject) => {
        let deletedMidStream = false;

        stream!.on('data', (chunk: Buffer) => {
          chunks.push(chunk);

          if (!deletedMidStream && chunks.length === 2) {
            // Mid-stream eviction / deletion!
            const released = store.delete('stream-key');
            expect(released).toBe(largePayload.byteLength);
            expect(store.has('stream-key')).toBe(false);
            expect(store.totalBytes).toBe(0);
            deletedMidStream = true;
          }
        });

        stream!.on('end', () => {
          resolve();
        });

        stream!.on('error', (err) => {
          reject(err);
        });
      });

      // Verify that full body was received intact with zero truncation
      const fullReceived = Buffer.concat(chunks);
      expect(fullReceived.byteLength).toBe(largePayload.byteLength);
      expect(fullReceived.equals(largePayload)).toBe(true);
    });

    it('does not corrupt in-flight stream when body is overwritten mid-stream', async () => {
      const store = new ObjectStore();
      const originalPayload = Buffer.alloc(200 * 1024, 0x11);
      const replacementPayload = Buffer.alloc(200 * 1024, 0x22);
      store.put('overwrite-stream-key', originalPayload);

      const stream = store.getStream('overwrite-stream-key', { chunkSize: 16 * 1024 });
      expect(stream).toBeDefined();

      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        let replacedMidStream = false;

        stream!.on('data', (chunk: Buffer) => {
          chunks.push(chunk);

          if (!replacedMidStream && chunks.length === 2) {
            // Overwrite entry in store mid-stream
            store.put('overwrite-stream-key', replacementPayload);
            replacedMidStream = true;
          }
        });

        stream!.on('end', () => resolve());
        stream!.on('error', reject);
      });

      const fullReceived = Buffer.concat(chunks);
      expect(fullReceived.byteLength).toBe(originalPayload.byteLength);
      expect(fullReceived.equals(originalPayload)).toBe(true);

      // Store now holds the replacement
      expect(store.get('overwrite-stream-key')?.equals(replacementPayload)).toBe(true);
    });
  });

  describe('Zero-byte and very large bodies', () => {
    it('handles zero-byte bodies cleanly', () => {
      const store = new ObjectStore();
      const emptyBuffer = Buffer.alloc(0);

      store.put('empty-key', emptyBuffer);
      expect(store.totalBytes).toBe(0);
      expect(store.sizeOf('empty-key')).toBe(0);
      expect(store.has('empty-key')).toBe(true);

      const retrieved = store.get('empty-key');
      expect(retrieved).toBeDefined();
      expect(retrieved?.byteLength).toBe(0);

      const deletedBytes = store.delete('empty-key');
      expect(deletedBytes).toBe(0);
      expect(store.has('empty-key')).toBe(false);
    });

    it('handles very large bodies cleanly up to multi-megabytes', () => {
      const store = new ObjectStore();
      const size3MB = 3 * 1024 * 1024;
      const largeBuffer = Buffer.alloc(size3MB, 0x5a);

      store.put('large-key', largeBuffer);
      expect(store.totalBytes).toBe(size3MB);
      expect(store.sumLiveBytes()).toBe(size3MB);

      const retrieved = store.get('large-key');
      expect(retrieved?.byteLength).toBe(size3MB);
      expect(retrieved?.equals(largeBuffer)).toBe(true);

      expect(store.delete('large-key')).toBe(size3MB);
      expect(store.totalBytes).toBe(0);
    });
  });
});
