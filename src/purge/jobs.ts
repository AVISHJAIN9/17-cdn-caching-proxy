import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PurgeIndex, PurgeTarget, PurgeResult } from './index-store.js';
import { CacheStore } from '../cache/store.js';
import { Clock, SystemClock } from '../util/clock.js';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled' | 'dead_letter';

export interface PurgeJob {
  id: string;
  idempotencyKey?: string;
  tenant: string;
  target: PurgeTarget;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxAttempts: number;
  matchedCount: number;
  purgedCount: number;
  errorSummary?: string;
  nextRetryAt?: number;
}

export interface JobQueueConfig {
  queueFile?: string;
  concurrency?: number; // default 2
  maxAttempts?: number; // default 3
  baseBackoffMs?: number; // default 100
  maxBackoffMs?: number; // default 5000
  clock?: Clock;
}

export class PurgeJobQueue {
  private readonly jobs = new Map<string, PurgeJob>();
  private readonly idempotencyMap = new Map<string, string>(); // idempotencyKey -> jobId
  private readonly config: Required<JobQueueConfig>;
  private readonly clock: Clock;
  private readonly purgeIndex: PurgeIndex;
  private readonly cacheStore?: CacheStore;
  private activeWorkers = 0;

  constructor(
    purgeIndex: PurgeIndex,
    cacheStore?: CacheStore,
    config: JobQueueConfig = {}
  ) {
    this.purgeIndex = purgeIndex;
    this.cacheStore = cacheStore;
    this.clock = config.clock ?? new SystemClock();
    this.config = {
      queueFile: config.queueFile ?? '',
      concurrency: config.concurrency ?? 2,
      maxAttempts: config.maxAttempts ?? 3,
      baseBackoffMs: config.baseBackoffMs ?? 100,
      maxBackoffMs: config.maxBackoffMs ?? 5000,
      clock: this.clock,
    };

    if (this.config.queueFile) {
      try {
        fs.mkdirSync(path.dirname(this.config.queueFile), { recursive: true });
        this.recoverFromDisk();
      } catch {}
    }
  }

  private persistSnapshot(): void {
    if (!this.config.queueFile) return;
    try {
      const data = JSON.stringify(Array.from(this.jobs.values()));
      const tmp = `${this.config.queueFile}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.config.queueFile);
    } catch {}
  }

  private recoverFromDisk(): void {
    if (!this.config.queueFile || !fs.existsSync(this.config.queueFile)) return;
    try {
      const content = fs.readFileSync(this.config.queueFile, 'utf8');
      const loaded: PurgeJob[] = JSON.parse(content);
      for (const job of loaded) {
        if (job.state === 'running') {
          // Reset interrupted running job to queued for resume
          job.state = 'queued';
        }
        this.jobs.set(job.id, job);
        if (job.idempotencyKey) {
          this.idempotencyMap.set(job.idempotencyKey, job.id);
        }
      }
    } catch {}
  }

  public submitJob(params: {
    target: PurgeTarget;
    tenant?: string;
    idempotencyKey?: string;
  }): PurgeJob {
    const tenant = params.tenant ?? params.target.tenant ?? 'default';

    // Idempotency check
    if (params.idempotencyKey && this.idempotencyMap.has(params.idempotencyKey)) {
      const existingId = this.idempotencyMap.get(params.idempotencyKey)!;
      return this.jobs.get(existingId)!;
    }

    const id = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job: PurgeJob = {
      id,
      idempotencyKey: params.idempotencyKey,
      tenant,
      target: { ...params.target, tenant },
      state: 'queued',
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      matchedCount: 0,
      purgedCount: 0,
    };

    this.jobs.set(id, job);
    if (params.idempotencyKey) {
      this.idempotencyMap.set(params.idempotencyKey, id);
    }

    this.persistSnapshot();
    this.scheduleDrain();
    return job;
  }

  public getJob(id: string): PurgeJob | undefined {
    return this.jobs.get(id);
  }

  public listJobs(filter: { status?: JobState; tenant?: string } = {}): PurgeJob[] {
    return Array.from(this.jobs.values()).filter((j) => {
      if (filter.status && j.state !== filter.status) return false;
      if (filter.tenant && j.tenant !== filter.tenant) return false;
      return true;
    });
  }

  public cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state === 'completed' || job.state === 'cancelled') {
      return false;
    }
    job.state = 'cancelled';
    job.updatedAt = this.clock.now();
    this.persistSnapshot();
    return true;
  }

  public retryDeadLetter(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'dead_letter') {
      return false;
    }
    job.state = 'queued';
    job.attempts = 0;
    job.updatedAt = this.clock.now();
    this.persistSnapshot();
    this.scheduleDrain();
    return true;
  }

  public scheduleDrain(): void {
    if (this.activeWorkers >= this.config.concurrency) return;

    const now = this.clock.now();
    for (const job of this.jobs.values()) {
      if (job.state === 'queued') {
        if (job.nextRetryAt && job.nextRetryAt > now) {
          continue;
        }
        this.runWorker(job);
        if (this.activeWorkers >= this.config.concurrency) break;
      }
    }
  }

  private async runWorker(job: PurgeJob): Promise<void> {
    this.activeWorkers++;
    job.state = 'running';
    job.attempts++;
    job.updatedAt = this.clock.now();
    this.persistSnapshot();

    try {
      const result: PurgeResult = this.purgeIndex.executePurge(job.target, this.cacheStore);
      job.matchedCount = result.matchedCount;
      job.purgedCount = result.purgedCount;
      job.state = 'completed';
      job.updatedAt = this.clock.now();
    } catch (err: any) {
      job.errorSummary = err?.message ?? String(err);
      if (job.attempts < job.maxAttempts) {
        job.state = 'queued';
        // Exponential backoff with full jitter
        const exp = Math.min(this.config.maxBackoffMs, this.config.baseBackoffMs * Math.pow(2, job.attempts));
        const jitter = Math.floor(Math.random() * exp);
        job.nextRetryAt = this.clock.now() + jitter;
      } else {
        job.state = 'dead_letter';
      }
      job.updatedAt = this.clock.now();
    } finally {
      this.activeWorkers--;
      this.persistSnapshot();
      this.scheduleDrain();
    }
  }
}
