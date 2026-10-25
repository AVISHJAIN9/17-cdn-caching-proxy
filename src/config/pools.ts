import { z } from 'zod';

export interface OriginPoolMember {
  origin: string;
  weight?: number;
  backup?: boolean;
}

export interface OriginPoolConfig {
  members: OriginPoolMember[];
  loadBalancing?: 'round-robin' | 'least-connections' | 'weighted';
  defaultMember?: string;
}

export const originPoolMemberSchema = z.object({
  origin: z.string().min(1, 'Origin ID in member must not be empty'),
  weight: z.number().int().positive().optional().default(1),
  backup: z.boolean().optional().default(false),
});

export const originPoolConfigSchema = z.object({
  members: z.array(originPoolMemberSchema).min(1, 'Pool must contain at least one member'),
  loadBalancing: z.enum(['round-robin', 'least-connections', 'weighted']).optional().default('round-robin'),
  defaultMember: z.string().optional(),
});

/**
 * State tracker for pool selections:
 * - Round-robin counters
 * - Weighted selection
 * - Active connections counter for least-connections
 * - Batch 12 isAvailable hook for health checking & circuit breaking
 */
export class PoolSelector {
  private roundRobinCounters = new Map<string, number>();
  private activeConnections = new Map<string, number>();

  /**
   * Availability hook for Batch 12 (active/passive health checks, circuit breakers).
   * If provided, returns false to exclude an origin from active selection.
   */
  public isAvailable?: (originId: string) => boolean;

  public selectMember(poolId: string, pool: OriginPoolConfig): string | undefined {
    if (!pool.members || pool.members.length === 0) {
      return undefined;
    }

    // Separate primary members from backup members
    const primaries = pool.members.filter((m) => !m.backup);
    const backups = pool.members.filter((m) => m.backup);

    // Filter available primaries
    let candidateMembers = primaries;
    if (this.isAvailable) {
      candidateMembers = primaries.filter((m) => this.isAvailable!(m.origin));
    }

    // If no healthy primaries are available, failover to backups
    if (candidateMembers.length === 0) {
      if (backups.length === 0) {
        return undefined;
      }
      let candidateBackups = backups;
      if (this.isAvailable) {
        candidateBackups = backups.filter((m) => this.isAvailable!(m.origin));
      }
      if (candidateBackups.length === 0) {
        return undefined;
      }
      // Backup ordering is respected: pick first available backup
      return candidateBackups[0].origin;
    }

    const strategy = pool.loadBalancing ?? 'round-robin';

    if (strategy === 'least-connections') {
      let minConns = Infinity;
      let bestMember = candidateMembers[0].origin;
      for (const m of candidateMembers) {
        const conns = this.activeConnections.get(m.origin) ?? 0;
        if (conns < minConns) {
          minConns = conns;
          bestMember = m.origin;
        }
      }
      return bestMember;
    }

    if (strategy === 'weighted') {
      const totalWeight = candidateMembers.reduce((sum, m) => sum + (m.weight ?? 1), 0);
      if (totalWeight <= 0) return candidateMembers[0].origin;
      const counter = this.roundRobinCounters.get(poolId) ?? 0;
      this.roundRobinCounters.set(poolId, (counter + 1) % totalWeight);
      let cumulative = 0;
      for (const m of candidateMembers) {
        cumulative += m.weight ?? 1;
        if (counter < cumulative) {
          return m.origin;
        }
      }
      return candidateMembers[0].origin;
    }

    // Default: round-robin
    const idx = (this.roundRobinCounters.get(poolId) ?? 0) % candidateMembers.length;
    this.roundRobinCounters.set(poolId, (idx + 1) % candidateMembers.length);
    return candidateMembers[idx].origin;
  }

  public recordConnectionStart(originId: string): void {
    const cur = this.activeConnections.get(originId) ?? 0;
    this.activeConnections.set(originId, cur + 1);
  }

  public recordConnectionEnd(originId: string): void {
    const cur = this.activeConnections.get(originId) ?? 0;
    this.activeConnections.set(originId, Math.max(0, cur - 1));
  }

  public getActiveConnections(originId: string): number {
    return this.activeConnections.get(originId) ?? 0;
  }

  public reset(): void {
    this.roundRobinCounters.clear();
    this.activeConnections.clear();
  }
}

export const defaultPoolSelector = new PoolSelector();
