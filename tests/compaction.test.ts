import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DiskCompactor, SegmentObject } from '../src/cache/compaction.js';
import { FakeClock } from '../src/util/clock.js';

describe('Feature 146: Disk Cache Compaction', () => {
  let segmentDir: string;
  let clock: FakeClock;

  beforeEach(() => {
    segmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-test-'));
    clock = new FakeClock(100000);
  });

  afterEach(() => {
    fs.rmSync(segmentDir, { recursive: true, force: true });
  });

  it('reclaims >= 95% of dead bytes in a fragmented segment fixture', () => {
    const compactor = new DiskCompactor({
      segmentDir,
      deadRatioThreshold: 0.4,
      clock,
    });

    // Create 10 objects: 6 live (1000 bytes each) and 4 dead (1000 bytes each) -> 40% dead
    const objects: SegmentObject[] = [];
    for (let i = 0; i < 10; i++) {
      const data = Buffer.alloc(1000, 0x30 + i);
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      objects.push({
        keyHash: `obj-${i}`,
        data,
        sha256,
        isDead: i < 5, // 5 dead objects = 50% dead ratio
      });
    }

    compactor.registerSegment('frag_seg_1', objects);

    const report = compactor.runOnce();
    expect(report.segmentsScanned).toBe(1);
    expect(report.segmentsRewritten).toBe(1);
    expect(report.bytesReclaimed).toBe(5000);
    expect(report.liveObjectsMoved).toBe(5);

    // Old segment should be unlinked
    expect(fs.existsSync(path.join(segmentDir, 'frag_seg_1.segment'))).toBe(false);
  });

  it('preserves old segment file while concurrent readers hold reference', () => {
    const compactor = new DiskCompactor({
      segmentDir,
      deadRatioThreshold: 0.3,
      clock,
    });

    const data = Buffer.from('important live data');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');

    compactor.registerSegment('active_seg', [
      { keyHash: 'live-1', data, sha256, isDead: false },
      { keyHash: 'dead-1', data: Buffer.alloc(2000, 0), sha256: '', isDead: true },
    ]);

    // Reader holds reference
    const releaseReader = compactor.acquireReader('active_seg');

    compactor.runOnce();

    // Old segment must still exist on disk while reader has reference
    const oldPath = path.join(segmentDir, 'active_seg.segment');
    expect(fs.existsSync(oldPath)).toBe(true);

    // Release reader -> segment unlinks
    releaseReader();
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it('recovers from simulated crash at step boundaries on startup', () => {
    const compactor = new DiskCompactor({
      segmentDir,
      clock,
    });

    const data = Buffer.from('data to be compacted');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    compactor.registerSegment('crash_seg', [
      { keyHash: 'k1', data, sha256, isDead: false },
      { keyHash: 'k2', data: Buffer.alloc(500, 0), sha256: '', isDead: true },
    ]);

    // Simulate crash after copy (throws during fault injection)
    try {
      compactor.runOnce((step) => {
        if (step === 'after_copy') {
          throw new Error('Simulated process SIGKILL after copy');
        }
      });
    } catch {}

    // A .tmp file exists
    const tmpFilesBefore = fs.readdirSync(segmentDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFilesBefore.length).toBeGreaterThanOrEqual(1);

    // Relaunching compactor triggers recoverOnStartup() in constructor
    new DiskCompactor({
      segmentDir,
      clock,
    });

    const tmpFilesAfter = fs.readdirSync(segmentDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFilesAfter.length).toBe(0);
  });
});
