/**
 * RFC 9110 Section 12.5.3 Accept-Encoding parser and normalizer.
 */

export interface ParsedEncodingPreference {
  encoding: string;
  q: number;
}

const MAX_HEADER_LENGTH = 32768;

/**
 * Parses an Accept-Encoding header into an array of encoding preferences with q-values.
 */
export function parseAcceptEncoding(header?: string | null): ParsedEncodingPreference[] {
  if (!header || typeof header !== 'string') {
    return [];
  }

  const trimmedHeader = header.trim();
  if (trimmedHeader.length === 0) {
    return [];
  }

  // Guard against overlong header inputs
  const boundedHeader = trimmedHeader.length > MAX_HEADER_LENGTH
    ? trimmedHeader.slice(0, MAX_HEADER_LENGTH)
    : trimmedHeader;

  const tokenMap = new Map<string, number>();
  const parts = boundedHeader.split(',');

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    const [rawToken, ...rawParams] = part.split(';');
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;

    let q = 1.0;
    for (const rawParam of rawParams) {
      const param = rawParam.trim();
      const match = param.match(/^q\s*=\s*(.*)$/i);
      if (match) {
        const valStr = match[1].trim();
        const parsedVal = parseFloat(valStr);
        if (Number.isNaN(parsedVal)) {
          q = 0.0;
        } else if (parsedVal > 1.0) {
          q = 1.0;
        } else if (parsedVal < 0.0) {
          q = 0.0;
        } else {
          q = Math.round(parsedVal * 1000) / 1000;
        }
      }
    }

    tokenMap.set(token, q);
  }

  const result: ParsedEncodingPreference[] = [];
  for (const [encoding, q] of tokenMap.entries()) {
    result.push({ encoding, q });
  }

  return result;
}

/**
 * Calculates the preference weight (q-value) for a specific encoding based on RFC 9110.
 */
export function getEncodingWeight(preferences: ParsedEncodingPreference[], encoding: string): number {
  const enc = encoding.toLowerCase();

  // 1. Direct match
  const direct = preferences.find((p) => p.encoding === enc);
  if (direct) {
    return direct.q;
  }

  // 2. Wildcard '*' match
  const wildcard = preferences.find((p) => p.encoding === '*');

  // 3. Special RFC 9110 rules for 'identity'
  if (enc === 'identity') {
    if (wildcard !== undefined) {
      return wildcard.q;
    }
    // If Accept-Encoding is empty/absent, identity is fully acceptable (1.0)
    if (preferences.length === 0) {
      return 1.0;
    }
    // RFC 9110: identity is acceptable unless explicitly refused via identity;q=0 or *;q=0
    return 0.001;
  }

  // 4. Non-identity fallback to wildcard
  if (wildcard !== undefined) {
    return wildcard.q;
  }

  return 0.0;
}

/**
 * Returns true if the specified encoding is acceptable (weight > 0).
 */
export function isEncodingAcceptable(preferences: ParsedEncodingPreference[], encoding: string): boolean {
  return getEncodingWeight(preferences, encoding) > 0;
}

/**
 * Normalizes an Accept-Encoding header into a canonical, sorted string of accepted
 * compression algorithms (excluding identity and refused q=0 codings).
 * Useful for deterministic variant keying.
 */
export function normalizeAcceptEncoding(header?: string | null): string {
  const preferences = parseAcceptEncoding(header);
  const accepted = preferences
    .filter((p) => p.q > 0 && p.encoding !== '*' && p.encoding !== 'identity')
    .map((p) => p.encoding)
    .sort();

  return [...new Set(accepted)].join(',');
}
