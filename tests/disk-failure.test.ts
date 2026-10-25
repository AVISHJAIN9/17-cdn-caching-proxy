import { describe, it, expect } from 'vitest';
import { FaultInjectingDisk } from '../src/stress/fault-disk.js';

describe('Feature 135: Disk failure testing', () => {
  it('detects ENOSPC write failures and EIO read errors cleanly', () => {
    const disk = new FaultInjectingDisk({ injectEnospc: true });
    expect(() => disk.write('/tmp/obj', Buffer.from('data'))).toThrow('ENOSPC');

    disk.options.injectEnospc = false;
    disk.write('/tmp/obj', Buffer.from('data'));

    disk.options.injectEio = true;
    expect(() => disk.read('/tmp/obj')).toThrow('EIO');

    // Corrupt byte detection
    disk.options.injectEio = false;
    disk.options.corruptByteOffset = 0;
    const corrupted = disk.read('/tmp/obj');
    expect(corrupted[0]).not.toBe(Buffer.from('data')[0]);
  });
});
