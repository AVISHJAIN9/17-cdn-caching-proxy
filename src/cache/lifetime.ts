/**
 * RFC 9111 Freshness Lifetime Calculation.
 * Pure function: freshnessLifetimeMs(response, config) -> { lifetimeMs, source }
 *
 * Precedence for shared cache (RFC 9111):
 * 1. s-maxage
 * 2. max-age
 * 3. Expires
 * 4. heuristic (support piece for Last-Modified)
 * 5. none
 */

import { z } from 'zod';
import { ParsedCacheControl } from './cache-control.js';
import { parseHttpDate } from './http-date.js';

export type LifetimeSource = 's-maxage' | 'max-age' | 'expires' | 'heuristic' | 'none' | 'invalid';

export interface FreshnessLifetimeResult {
  lifetimeMs: number;
  source: LifetimeSource;
}

export const heuristicConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ratio: z.number().gt(0).lte(1).default(0.1),
  maxMs: z.number().nonnegative().default(86400000),
});

export type HeuristicConfig = z.infer<typeof heuristicConfigSchema>;

export interface LifetimeConfig {
  maxTtlMs?: number; // default 86400000 (1 day)
  minTtlMs?: number; // default 0 (no raising of origin freshness)
  heuristic?: HeuristicConfig;
}

export interface LifetimeInput {
  cacheControl: ParsedCacheControl;
  expiresHeader?: string;
  dateMs: number;
  lastModifiedMs?: number;
}

const DEFAULT_MAX_TTL_MS = 86400000; // 24 hours

export function freshnessLifetimeMs(
  response: LifetimeInput,
  config?: LifetimeConfig
): FreshnessLifetimeResult {
  const maxTtlMs = config?.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  const cc = response.cacheControl;

  // 1. Check s-maxage
  const hasSMaxAge = cc.sMaxAge !== undefined || cc.invalid.includes('s-maxage');
  if (hasSMaxAge) {
    if (cc.invalid.includes('s-maxage')) {
      return { lifetimeMs: 0, source: 'invalid' };
    }
    const rawMs = (cc.sMaxAge ?? 0) * 1000;
    const lifetimeMs = Math.min(Math.max(0, rawMs), maxTtlMs);
    return { lifetimeMs, source: 's-maxage' };
  }

  // 2. Check max-age
  const hasMaxAge = cc.maxAge !== undefined || cc.invalid.includes('max-age');
  if (hasMaxAge) {
    if (cc.invalid.includes('max-age')) {
      return { lifetimeMs: 0, source: 'invalid' };
    }
    const rawMs = (cc.maxAge ?? 0) * 1000;
    const lifetimeMs = Math.min(Math.max(0, rawMs), maxTtlMs);
    return { lifetimeMs, source: 'max-age' };
  }

  // 3. Check Expires (RFC 9111 Section 5.3)
  // Note: Per RFC 9111, Expires is ignored whenever s-maxage or max-age is present (handled above).
  if (response.expiresHeader !== undefined) {
    const parsedExpires = parseHttpDate(response.expiresHeader);
    if (parsedExpires === null) {
      // RFC 9111 Section 5.3: Invalid date (e.g. "0", "-1", malformed) means "already expired"
      return { lifetimeMs: 0, source: 'expires' };
    }
    const rawLifetime = parsedExpires - response.dateMs;
    const clamped = Math.max(0, rawLifetime);
    const lifetimeMs = Math.min(clamped, maxTtlMs);
    return { lifetimeMs, source: 'expires' };
  }

  // 4. Check Heuristic freshness (support piece for Last-Modified)
  // Applies ONLY when:
  // - No s-maxage, no max-age, no Expires header at all
  // - Not no-store/private/no-cache
  // - Valid lastModifiedMs present
  // - lastModifiedMs <= dateValueMs (future Last-Modified gets no heuristic)
  const heuristic = config?.heuristic ?? { enabled: true, ratio: 0.1, maxMs: DEFAULT_MAX_TTL_MS };
  if (
    heuristic.enabled !== false &&
    !cc.noStore &&
    !cc.private &&
    !cc.noCache &&
    response.lastModifiedMs !== undefined &&
    response.lastModifiedMs <= response.dateMs
  ) {
    const ratio = heuristic.ratio ?? 0.1;
    const maxMs = heuristic.maxMs ?? DEFAULT_MAX_TTL_MS;
    const effectiveMax = Math.min(maxMs, maxTtlMs);
    const delta = response.dateMs - response.lastModifiedMs;
    const lifetime = Math.min(Math.floor(ratio * delta), effectiveMax);
    return { lifetimeMs: lifetime, source: 'heuristic' };
  }

  return { lifetimeMs: 0, source: 'none' };
}
