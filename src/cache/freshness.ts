/**
 * RFC 9111 Section 4.2.3: Calculating Age and Freshness.
 * Pure calculation functions.
 */

import { CacheEntry } from './store.js';
import { parseHttpDate } from './http-date.js';

const MAX_DELTA_SECONDS = 2147483648; // Cap at 2^31 per RFC 9111

/**
 * Parses origin Age header(s).
 * - Digits only
 * - If missing, non-numeric, negative, or invalid: 0
 * - Values > 2147483648 are capped at 2147483648
 * - If multiple Age headers or comma-separated values disagree, use the largest
 */
export function parseAgeHeader(ageHeader: string | string[] | undefined): number {
  if (!ageHeader) {
    return 0;
  }

  const rawValues = Array.isArray(ageHeader) ? ageHeader.join(',') : ageHeader;
  const parts = rawValues.split(',');
  let maxAgeSeconds = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Must be digits only
    let valid = true;
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code < 48 || code > 57) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    if (trimmed.length > 10) {
      maxAgeSeconds = Math.max(maxAgeSeconds, MAX_DELTA_SECONDS);
      continue;
    }

    const val = Number(trimmed);
    if (Number.isFinite(val) && val >= 0) {
      const capped = Math.min(val, MAX_DELTA_SECONDS);
      if (capped > maxAgeSeconds) {
        maxAgeSeconds = capped;
      }
    }
  }

  return maxAgeSeconds;
}

/**
 * Parses response Date header to epoch ms.
 * RFC 9110 Section 6.6.1: A recipient with no valid Date uses its own receive time (responseTimeMs).
 */
export function parseResponseDate(
  dateHeader: string | string[] | undefined,
  responseTimeMs: number
): number {
  if (!dateHeader) {
    return responseTimeMs;
  }
  const dateStr = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
  const parsed = parseHttpDate(dateStr);
  return parsed !== null ? parsed : responseTimeMs;
}

export type AgeMetadata = Pick<
  CacheEntry,
  'requestTimeMs' | 'responseTimeMs' | 'dateValueMs' | 'ageValueSeconds'
>;

/**
 * RFC 9111 Section 4.2.3: Calculating Age
 *
 * apparent_age = max(0, response_time - date_value);
 * response_delay = response_time - request_time;
 * corrected_age_value = age_value * 1000 + response_delay;
 * corrected_initial_age = max(apparent_age, corrected_age_value);
 * resident_time = now - response_time;
 * current_age = corrected_initial_age + resident_time;
 *
 * Negatives are clamped to 0. Guard against clock going backwards (resident_time < 0 becomes 0).
 */
export function currentAgeMs(entry: AgeMetadata, nowMs: number): number {
  const apparentAge = Math.max(0, entry.responseTimeMs - entry.dateValueMs);
  const responseDelay = Math.max(0, entry.responseTimeMs - entry.requestTimeMs);
  const correctedAgeValue = entry.ageValueSeconds * 1000 + responseDelay;
  const correctedInitialAge = Math.max(apparentAge, correctedAgeValue);
  const residentTime = Math.max(0, nowMs - entry.responseTimeMs);
  const currentAge = correctedInitialAge + residentTime;

  return Math.max(0, currentAge);
}

/**
 * Determines whether a cache entry is fresh per RFC 9111.
 * Freshness lifetime must be strictly greater than current age.
 * (Age == lifetime is stale).
 */
export function isFresh(
  entry: Pick<
    CacheEntry,
    'requestTimeMs' | 'responseTimeMs' | 'dateValueMs' | 'ageValueSeconds' | 'freshnessLifetimeMs'
  >,
  nowMs: number
): boolean {
  return entry.freshnessLifetimeMs > currentAgeMs(entry, nowMs);
}
