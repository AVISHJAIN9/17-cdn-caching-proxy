import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string;
  tenant: string;
  action: string;
  scope: string;
  target: string;
  outcome: 'success' | 'denied' | 'failed';
  details?: Record<string, any>;
  prevHash: string;
  hash: string;
}

export class PurgeAuditTrail {
  private readonly entries: AuditEntry[] = [];
  private lastHash: string = '0000000000000000000000000000000000000000000000000000000000000000';
  private readonly logFilePath?: string;

  constructor(options: { logFilePath?: string } = {}) {
    this.logFilePath = options.logFilePath;
    if (this.logFilePath) {
      try {
        fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      } catch {}
    }
  }

  /**
   * Computes SHA-256 hash across entry payload and previous link.
   */
  private computeHash(
    entry: Omit<AuditEntry, 'hash'>
  ): string {
    const serialized = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      actor: entry.actor,
      tenant: entry.tenant,
      action: entry.action,
      scope: entry.scope,
      target: entry.target,
      outcome: entry.outcome,
      details: entry.details,
      prevHash: entry.prevHash,
    });
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  public record(params: {
    actor: string;
    tenant: string;
    action: string;
    scope: string;
    target: string;
    outcome: 'success' | 'denied' | 'failed';
    details?: Record<string, any>;
    timestamp?: number;
  }): AuditEntry {
    const id = `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = params.timestamp ?? Date.now();

    const partial: Omit<AuditEntry, 'hash'> = {
      id,
      timestamp,
      actor: params.actor,
      tenant: params.tenant,
      action: params.action,
      scope: params.scope,
      target: params.target,
      outcome: params.outcome,
      details: params.details,
      prevHash: this.lastHash,
    };

    const hash = this.computeHash(partial);
    const entry: AuditEntry = { ...partial, hash };

    this.entries.push(entry);
    this.lastHash = hash;

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n');
      } catch {}
    }

    return entry;
  }

  public query(filter: {
    tenant?: string;
    actor?: string;
    from?: number;
    to?: number;
  } = {}): AuditEntry[] {
    return this.entries.filter((e) => {
      if (filter.tenant && e.tenant !== filter.tenant) return false;
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.from && e.timestamp < filter.from) return false;
      if (filter.to && e.timestamp > filter.to) return false;
      return true;
    });
  }

  /**
   * Verifies the cryptographic integrity of the SHA-256 tamper-evident chain.
   */
  public verify(): { valid: boolean; brokenAtIndex?: number; brokenEntryId?: string } {
    let expectedPrev = '0000000000000000000000000000000000000000000000000000000000000000';

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.prevHash !== expectedPrev) {
        return { valid: false, brokenAtIndex: i, brokenEntryId: entry.id };
      }

      const computed = this.computeHash(entry);
      if (computed !== entry.hash) {
        return { valid: false, brokenAtIndex: i, brokenEntryId: entry.id };
      }

      expectedPrev = entry.hash;
    }

    return { valid: true };
  }

  public count(): number {
    return this.entries.length;
  }
}
