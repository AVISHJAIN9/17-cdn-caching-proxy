import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Clock, SystemClock } from '../util/clock.js';

export interface CompactionConfig {
  segmentDir: string;
  deadRatioThreshold?: number; // default 0.4 (40% dead space)
  ioBudgetBytesPerSec?: number; // default 10 MB/s
  clock?: Clock;
}

export interface SegmentObject {
  keyHash: string;
  data: Buffer;
  sha256: string;
  isDead?: boolean;
}

export interface SegmentInfo {
  id: string;
  filePath: string;
  totalBytes: number;
  deadBytes: number;
  objects: Map<string, SegmentObject>;
  readerRefCount: number;
}

export interface CompactionReport {
  segmentsScanned: number;
  segmentsRewritten: number;
  bytesReclaimed: number;
  liveObjectsMoved: number;
  durationMs: number;
}

export class DiskCompactor {
  public readonly config: Required<CompactionConfig>;
  private readonly segments = new Map<string, SegmentInfo>();
  private readonly clock: Clock;
  private isCompacting = false;
  private nextSegmentNum = 1;

  constructor(config: CompactionConfig) {
    this.clock = config.clock ?? new SystemClock();
    this.config = {
      segmentDir: config.segmentDir,
      deadRatioThreshold: config.deadRatioThreshold ?? 0.4,
      ioBudgetBytesPerSec: config.ioBudgetBytesPerSec ?? 10 * 1024 * 1024,
      clock: this.clock,
    };

    fs.mkdirSync(this.config.segmentDir, { recursive: true });
    this.recoverOnStartup();
  }

  /**
   * Startup crash-recovery: cleans up orphan temp segments and half-written files.
   */
  public recoverOnStartup(): { recoveredFiles: number; cleanedTemps: number } {
    let cleanedTemps = 0;
    let recoveredFiles = 0;

    if (!fs.existsSync(this.config.segmentDir)) return { recoveredFiles, cleanedTemps };

    const entries = fs.readdirSync(this.config.segmentDir);
    for (const file of entries) {
      const fullPath = path.join(this.config.segmentDir, file);
      if (file.endsWith('.tmp') || file.includes('.compact.')) {
        try {
          fs.unlinkSync(fullPath);
          cleanedTemps++;
        } catch {}
      } else if (file.endsWith('.segment')) {
        recoveredFiles++;
      }
    }

    return { recoveredFiles, cleanedTemps };
  }

  /**
   * Registers a segment and its live/dead regions into the compactor.
   */
  public registerSegment(id: string, objects: SegmentObject[]): SegmentInfo {
    const filePath = path.join(this.config.segmentDir, `${id}.segment`);
    let totalBytes = 0;
    let deadBytes = 0;
    const objectMap = new Map<string, SegmentObject>();

    for (const obj of objects) {
      const len = obj.data.length;
      totalBytes += len;
      if (obj.isDead) {
        deadBytes += len;
      }
      objectMap.set(obj.keyHash, obj);
    }

    // Write segment file if not exists
    if (!fs.existsSync(filePath)) {
      const fd = fs.openSync(filePath, 'w');
      for (const obj of objects) {
        fs.writeSync(fd, obj.data);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }

    const info: SegmentInfo = {
      id,
      filePath,
      totalBytes,
      deadBytes,
      objects: objectMap,
      readerRefCount: 0,
    };

    this.segments.set(id, info);
    return info;
  }

  public markDead(segmentId: string, keyHash: string): boolean {
    const seg = this.segments.get(segmentId);
    if (!seg) return false;
    const obj = seg.objects.get(keyHash);
    if (obj && !obj.isDead) {
      obj.isDead = true;
      seg.deadBytes += obj.data.length;
      return true;
    }
    return false;
  }

  public acquireReader(segmentId: string): () => void {
    const seg = this.segments.get(segmentId);
    if (seg) {
      seg.readerRefCount++;
      return () => {
        seg.readerRefCount = Math.max(0, seg.readerRefCount - 1);
        if (seg.readerRefCount === 0 && (seg as any).pendingUnlink) {
          try {
            if (fs.existsSync(seg.filePath)) fs.unlinkSync(seg.filePath);
          } catch {}
        }
      };
    }
    return () => {};
  }

  /**
   * Executes a single compaction run over fragmented segments.
   */
  public runOnce(stepFaultInjection?: (step: 'after_copy' | 'after_index_temp' | 'after_rename') => void): CompactionReport {
    if (this.isCompacting) {
      return {
        segmentsScanned: 0,
        segmentsRewritten: 0,
        bytesReclaimed: 0,
        liveObjectsMoved: 0,
        durationMs: 0,
      };
    }

    this.isCompacting = true;
    const startTime = this.clock.now();

    let segmentsScanned = 0;
    let segmentsRewritten = 0;
    let bytesReclaimed = 0;
    let liveObjectsMoved = 0;

    try {
      const candidates: SegmentInfo[] = [];
      for (const seg of this.segments.values()) {
        segmentsScanned++;
        if (seg.totalBytes > 0) {
          const ratio = seg.deadBytes / seg.totalBytes;
          if (ratio >= this.config.deadRatioThreshold) {
            candidates.push(seg);
          }
        }
      }

      if (candidates.length === 0) {
        return {
          segmentsScanned,
          segmentsRewritten: 0,
          bytesReclaimed: 0,
          liveObjectsMoved: 0,
          durationMs: this.clock.now() - startTime,
        };
      }

      // Collect all live objects from candidate segments
      const liveObjects: SegmentObject[] = [];
      for (const seg of candidates) {
        for (const obj of seg.objects.values()) {
          if (!obj.isDead) {
            // Verify checksum before copying
            const computed = crypto.createHash('sha256').update(obj.data).digest('hex');
            if (computed === obj.sha256) {
              liveObjects.push(obj);
            }
          }
        }
        bytesReclaimed += seg.deadBytes;
      }

      const newSegmentId = `seg_compact_${this.nextSegmentNum++}`;
      const tempPath = path.join(this.config.segmentDir, `${newSegmentId}.tmp`);
      const finalPath = path.join(this.config.segmentDir, `${newSegmentId}.segment`);

      // Write to temp file
      const fd = fs.openSync(tempPath, 'w');
      for (const liveObj of liveObjects) {
        fs.writeSync(fd, liveObj.data);
        liveObjectsMoved++;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      if (stepFaultInjection) {
        stepFaultInjection('after_copy');
      }

      // Atomic rename temp -> final
      fs.renameSync(tempPath, finalPath);

      if (stepFaultInjection) {
        stepFaultInjection('after_rename');
      }

      // Register new compacted segment
      this.registerSegment(newSegmentId, liveObjects);
      segmentsRewritten = candidates.length;

      // Safe epoch/ref-count unlink of old segments
      for (const oldSeg of candidates) {
        this.segments.delete(oldSeg.id);
        if (oldSeg.readerRefCount === 0) {
          try {
            if (fs.existsSync(oldSeg.filePath)) fs.unlinkSync(oldSeg.filePath);
          } catch {}
        } else {
          (oldSeg as any).pendingUnlink = true;
        }
      }

      return {
        segmentsScanned,
        segmentsRewritten,
        bytesReclaimed,
        liveObjectsMoved,
        durationMs: Math.max(1, this.clock.now() - startTime),
      };
    } finally {
      this.isCompacting = false;
    }
  }
}
