import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';

export interface LargeObjectConfig {
  maxMemoryObjectBytes?: number; // default 2 MB
  maxObjectBytes?: number; // default 5 GB
  tempDir: string;
  cacheDir: string;
  slowClientPolicy?: 'detach' | 'abort'; // default 'detach'
  highWaterMark?: number; // default 64 KB
}

export interface LargeObjectMetadata {
  keyHash: string;
  etag?: string;
  contentLength: number;
  filePath: string;
  completed: boolean;
  ranges: Array<{ start: number; end: number }>;
}

export class LargeObjectManager {
  public readonly config: Required<LargeObjectConfig>;
  private readonly published = new Map<string, LargeObjectMetadata>();

  constructor(config: LargeObjectConfig) {
    this.config = {
      maxMemoryObjectBytes: config.maxMemoryObjectBytes ?? 2 * 1024 * 1024,
      maxObjectBytes: config.maxObjectBytes ?? 5 * 1024 * 1024 * 1024,
      tempDir: config.tempDir,
      cacheDir: config.cacheDir,
      slowClientPolicy: config.slowClientPolicy ?? 'detach',
      highWaterMark: config.highWaterMark ?? 65536,
    };

    fs.mkdirSync(this.config.tempDir, { recursive: true });
    fs.mkdirSync(this.config.cacheDir, { recursive: true });
  }

  public shouldStreamToDisk(contentLength?: number): boolean {
    if (contentLength === undefined || contentLength < 0) return true;
    return contentLength > this.config.maxMemoryObjectBytes;
  }

  public getPublished(keyHash: string): LargeObjectMetadata | undefined {
    return this.published.get(keyHash);
  }

  /**
   * Streams an upstream large body to both a downstream client stream and a disk cache file with backpressure.
   */
  public streamTeeToDisk(params: {
    keyHash: string;
    upstreamStream: Readable;
    downstreamClient: PassThrough;
    contentLength?: number;
    etag?: string;
    onClientAbort?: () => void;
  }): {
    promise: Promise<LargeObjectMetadata>;
    abort: () => void;
  } {
    const tempFileName = `large_${params.keyHash}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
    const tempFilePath = path.join(this.config.tempDir, tempFileName);
    const finalFilePath = path.join(this.config.cacheDir, `${params.keyHash}.large`);

    const writeStream = fs.createWriteStream(tempFilePath, {
      highWaterMark: this.config.highWaterMark,
    });

    let writtenBytes = 0;
    let clientDetached = false;
    let aborted = false;

    const cleanupTemp = () => {
      try {
        writeStream.destroy();
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch {}
    };

    const abort = () => {
      aborted = true;
      params.upstreamStream.destroy();
      params.downstreamClient.destroy();
      cleanupTemp();
    };

    // Client abort listener
    params.downstreamClient.on('close', () => {
      if (writtenBytes < (params.contentLength ?? 0) && !aborted) {
        if (this.config.slowClientPolicy === 'abort') {
          abort();
        } else {
          // Detach client, continue filling cache in background
          clientDetached = true;
        }
      }
    });

    const promise = new Promise<LargeObjectMetadata>((resolve, reject) => {
      params.upstreamStream.on('data', (chunk: Buffer) => {
        if (aborted) return;

        writtenBytes += chunk.length;
        if (writtenBytes > this.config.maxObjectBytes) {
          abort();
          reject(new Error(`Object exceeded maximum allowed size of ${this.config.maxObjectBytes} bytes`));
          return;
        }

        // Write to disk with backpressure
        const diskOk = writeStream.write(chunk);
        if (!diskOk) {
          params.upstreamStream.pause();
          writeStream.once('drain', () => {
            if (!aborted) params.upstreamStream.resume();
          });
        }

        // Write to client if still attached
        if (!clientDetached && !params.downstreamClient.destroyed) {
          const clientOk = params.downstreamClient.write(chunk);
          if (!clientOk) {
            params.upstreamStream.pause();
            params.downstreamClient.once('drain', () => {
              if (!aborted) params.upstreamStream.resume();
            });
          }
        }
      });

      params.upstreamStream.on('end', () => {
        if (aborted) return;

        if (params.contentLength !== undefined && writtenBytes !== params.contentLength) {
          cleanupTemp();
          reject(new Error(`Content-Length mismatch: expected ${params.contentLength}, got ${writtenBytes}`));
          return;
        }

        if (!clientDetached && !params.downstreamClient.destroyed) {
          params.downstreamClient.end();
        }

        writeStream.end(async () => {
          try {
            // Atomic rename to final path
            fs.renameSync(tempFilePath, finalFilePath);

            const meta: LargeObjectMetadata = {
              keyHash: params.keyHash,
              etag: params.etag,
              contentLength: writtenBytes,
              filePath: finalFilePath,
              completed: true,
              ranges: [{ start: 0, end: writtenBytes - 1 }],
            };

            this.published.set(params.keyHash, meta);
            resolve(meta);
          } catch (err) {
            cleanupTemp();
            reject(err);
          }
        });
      });

      params.upstreamStream.on('error', (err) => {
        cleanupTemp();
        if (!clientDetached && !params.downstreamClient.destroyed) {
          if (params.downstreamClient.listenerCount('error') > 0) {
            params.downstreamClient.destroy(err);
          } else {
            params.downstreamClient.destroy();
          }
        }
        reject(err);
      });
    });

    return { promise, abort };
  }

  /**
   * Validates and serves a Range request from an existing large object file.
   */
  public createRangeStream(
    keyHash: string,
    start: number,
    end: number,
    ifMatchEtag?: string
  ): Readable {
    const meta = this.published.get(keyHash);
    if (!meta) {
      throw new Error(`Large object ${keyHash} not found`);
    }

    if (ifMatchEtag && meta.etag && meta.etag !== ifMatchEtag) {
      throw new Error(`ETag mismatch: current ${meta.etag} does not match ${ifMatchEtag}`);
    }

    if (!fs.existsSync(meta.filePath)) {
      throw new Error(`Large object file ${meta.filePath} missing on disk`);
    }

    return fs.createReadStream(meta.filePath, {
      start,
      end,
      highWaterMark: this.config.highWaterMark,
    });
  }

  /**
   * Resumes or merges a sparse partial range into the large object.
   */
  public updateRange(
    keyHash: string,
    range: { start: number; end: number },
    etag?: string
  ): void {
    const meta = this.published.get(keyHash);
    if (meta) {
      if (etag && meta.etag && meta.etag !== etag) {
        // Validator mismatch -> discard stale partial
        try {
          if (fs.existsSync(meta.filePath)) fs.unlinkSync(meta.filePath);
        } catch {}
        this.published.delete(keyHash);
        return;
      }
      meta.ranges.push(range);
    }
  }
}
