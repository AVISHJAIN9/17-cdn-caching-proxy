import { Readable } from 'node:stream';

export interface ObjectStreamOptions {
  chunkSize?: number;
}

/**
 * ObjectStore provides decoupled in-memory payload storage separate from metadata.
 * Features byte-accurate size tracking and streaming-safe reads that survive
 * concurrent eviction, replacement, or deletion.
 */
export class ObjectStore {
  private readonly bodies: Map<string, Buffer> = new Map();
  private currentBytes = 0;

  put(keyHash: string, body: Buffer): { size: number; replacedSize: number } {
    const existing = this.bodies.get(keyHash);
    let replacedSize = 0;

    if (existing) {
      replacedSize = existing.byteLength;
      this.currentBytes -= replacedSize;
    }

    const storedBuffer = Buffer.from(body);
    this.bodies.set(keyHash, storedBuffer);
    this.currentBytes += storedBuffer.byteLength;

    return {
      size: storedBuffer.byteLength,
      replacedSize,
    };
  }

  get(keyHash: string): Buffer | undefined {
    const buf = this.bodies.get(keyHash);
    if (!buf) return undefined;
    return Buffer.from(buf);
  }

  /**
   * Returns a streaming-safe Readable stream for the object body.
   * Retains an immutable reference to the buffer snapshot so concurrent
   * eviction, deletion, or replacement never corrupts or truncates the in-flight read.
   */
  getStream(keyHash: string, options?: ObjectStreamOptions): Readable | undefined {
    const buf = this.bodies.get(keyHash);
    if (!buf) return undefined;

    const snapshot = buf;
    const chunkSize = options?.chunkSize ?? 64 * 1024;
    let offset = 0;

    return new Readable({
      read() {
        if (offset >= snapshot.byteLength) {
          this.push(null);
          return;
        }
        const end = Math.min(offset + chunkSize, snapshot.byteLength);
        const chunk = snapshot.subarray(offset, end);
        offset = end;
        this.push(chunk);
      },
    });
  }

  delete(keyHash: string): number {
    const existing = this.bodies.get(keyHash);
    if (!existing) return 0;

    const released = existing.byteLength;
    this.bodies.delete(keyHash);
    this.currentBytes -= released;
    return released;
  }

  has(keyHash: string): boolean {
    return this.bodies.has(keyHash);
  }

  sizeOf(keyHash: string): number | undefined {
    return this.bodies.get(keyHash)?.byteLength;
  }

  get totalBytes(): number {
    return this.currentBytes;
  }

  get count(): number {
    return this.bodies.size;
  }

  sumLiveBytes(): number {
    let sum = 0;
    for (const b of this.bodies.values()) {
      sum += b.byteLength;
    }
    return sum;
  }

  keys(): IterableIterator<string> {
    return this.bodies.keys();
  }

  clear(): void {
    this.bodies.clear();
    this.currentBytes = 0;
  }
}
