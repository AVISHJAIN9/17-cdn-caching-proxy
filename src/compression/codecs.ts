import zlib from 'node:zlib';
import stream, { Transform, TransformCallback, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type CompressionCodec = 'gzip' | 'br' | 'zstd';

export interface CodecOptions {
  level?: number;
  maxDecompressedBytes?: number;
}

export class DecompressionBombError extends Error {
  public statusCode = 502;
  public code = 'DECOMPRESSION_BOMB_DETECTED';
  constructor(limit: number) {
    super(`DECOMPRESSION_BOMB_DETECTED: Exceeded maximum allowed decompressed size of ${limit} bytes`);
    this.name = 'DecompressionBombError';
  }
}

export class DecompressionBombLimiter extends Transform {
  private totalBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = 104857600) {
    super();
    this.maxBytes = maxBytes;
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: TransformCallback): void {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.totalBytes += len;
    if (this.totalBytes > this.maxBytes) {
      callback(new DecompressionBombError(this.maxBytes));
      return;
    }
    callback(null, chunk);
  }
}

export interface CompressionLevelsConfig {
  gzip?: number;
  br?: number;
  brotli?: number;
  zstd?: number;
}

export const DEFAULT_COMPRESSION_LEVELS = {
  gzip: 6,
  br: 4,
  brotli: 4,
  zstd: 3,
} as const;

export function validateCompressionLevel(codec: CompressionCodec | 'brotli', level?: number): number {
  const normCodec: CompressionCodec = codec === 'brotli' ? 'br' : codec;
  if (level === undefined) {
    return DEFAULT_COMPRESSION_LEVELS[normCodec];
  }
  if (!Number.isInteger(level)) {
    throw new Error(`Invalid ${codec} compression level: ${level}. Must be an integer.`);
  }
  switch (normCodec) {
    case 'gzip':
      if (level < 1 || level > 9) {
        throw new Error(`Invalid gzip compression level: ${level}. Must be an integer between 1 and 9.`);
      }
      return level;
    case 'br':
      if (level < 0 || level > 11) {
        throw new Error(`Invalid brotli compression level: ${level}. Must be an integer between 0 and 11.`);
      }
      return level;
    case 'zstd':
      if (level < 1 || level > 22) {
        throw new Error(`Invalid zstd compression level: ${level}. Must be an integer between 1 and 22.`);
      }
      return level;
    default:
      throw new Error(`Unknown codec: ${codec}`);
  }
}

/**
 * Creates a streaming compressor for the requested codec.
 */
export function createCompressor(codec: CompressionCodec, options: CodecOptions = {}): Transform {
  const level = validateCompressionLevel(codec, options.level);
  switch (codec) {
    case 'gzip':
      return zlib.createGzip({
        level,
      });
    case 'br':
      return zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: level,
        },
      });
    case 'zstd':
      if (typeof (zlib as any).createZstdCompress !== 'function') {
        throw new Error('Zstandard compression is not supported by node:zlib in this runtime');
      }
      return (zlib as any).createZstdCompress({
        level,
      });
    default:
      throw new Error(`Unsupported compression codec: ${codec}`);
  }
}

/**
 * Creates a streaming decompressor for the requested codec, optionally enforcing
 * a decompression bomb limit on total decoded bytes.
 */
export function createDecompressor(codec: CompressionCodec, options: CodecOptions = {}): any {
  let decompressTransform: Transform;

  switch (codec) {
    case 'gzip':
      decompressTransform = zlib.createGunzip();
      break;
    case 'br':
      decompressTransform = zlib.createBrotliDecompress();
      break;
    case 'zstd':
      if (typeof (zlib as any).createZstdDecompress !== 'function') {
        throw new Error('Zstandard decompression is not supported by node:zlib in this runtime');
      }
      decompressTransform = (zlib as any).createZstdDecompress();
      break;
    default:
      throw new Error(`Unsupported decompression codec: ${codec}`);
  }

  if (options.maxDecompressedBytes !== undefined) {
    const limiter = new DecompressionBombLimiter(options.maxDecompressedBytes);
    return (stream as any).compose(decompressTransform, limiter);
  }

  return decompressTransform;
}

class BufferCollector extends Transform {
  public readonly chunks: Buffer[] = [];
  _transform(chunk: any, _enc: BufferEncoding, callback: TransformCallback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

/**
 * Compresses an in-memory buffer.
 */
export async function compressBuffer(
  buf: Buffer,
  codec: CompressionCodec,
  options: CodecOptions = {}
): Promise<Buffer> {
  const compressor = createCompressor(codec, options);
  const collector = new BufferCollector();
  await pipeline(Readable.from([buf]), compressor, collector);
  return Buffer.concat(collector.chunks);
}

/**
 * Decompresses an in-memory buffer, enforcing decompression bomb limits if provided.
 */
export async function decompressBuffer(
  buf: Buffer,
  codec: CompressionCodec,
  options: CodecOptions = {}
): Promise<Buffer> {
  const decompressor = createDecompressor(codec, options);
  const collector = new BufferCollector();
  await pipeline(Readable.from([buf]), decompressor, collector);
  return Buffer.concat(collector.chunks);
}
