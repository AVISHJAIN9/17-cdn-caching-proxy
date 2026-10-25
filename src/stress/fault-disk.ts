export interface DiskFaultOptions {
  injectEnospc?: boolean;
  injectEio?: boolean;
  corruptByteOffset?: number;
}

export class FaultInjectingDisk {
  public options: DiskFaultOptions;
  public totalWrites = 0;
  public totalReads = 0;
  private readonly storage = new Map<string, Buffer>();

  constructor(options: DiskFaultOptions = {}) {
    this.options = { ...options };
  }

  public write(filePath: string, data: Buffer): void {
    if (this.options.injectEnospc) {
      const err: any = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    this.totalWrites++;
    this.storage.set(filePath, Buffer.from(data));
  }

  public read(filePath: string): Buffer {
    if (this.options.injectEio) {
      const err: any = new Error('EIO: i/o error');
      err.code = 'EIO';
      throw err;
    }
    const data = this.storage.get(filePath);
    if (!data) {
      const err: any = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    }
    this.totalReads++;

    if (this.options.corruptByteOffset !== undefined && this.options.corruptByteOffset < data.length) {
      const corrupted = Buffer.from(data);
      corrupted[this.options.corruptByteOffset] ^= 0xff; // Flip bits
      return corrupted;
    }

    return data;
  }

  public exists(filePath: string): boolean {
    return this.storage.has(filePath);
  }

  public unlink(filePath: string): void {
    this.storage.delete(filePath);
  }
}
