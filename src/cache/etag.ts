/**
 * RFC 9110 Section 8.8.3: Entity Tag (ETag) parser, scanner, and matcher.
 * Pure functions:
 * - parseEntityTag(raw: string): EntityTag | null
 * - parseEntityTagList(headerValues: string | string[] | undefined): EntityTagListResult
 * - weakMatch(a: EntityTag, b: EntityTag): boolean
 * - strongMatch(a: EntityTag, b: EntityTag): boolean
 */

export interface EntityTag {
  weak: boolean;
  opaque: string;
  raw: string;
}

export type EntityTagListResult =
  | { kind: 'star' }
  | { kind: 'tags'; tags: EntityTag[] }
  | { kind: 'invalid' }
  | { kind: 'absent' };

/**
 * Validates etagc character per RFC 9110 Section 8.8.3:
 * etagc = %x21 / %x23-7E / obs-text (%x80-FF)
 * Excludes:
 * - DQUOTE (0x22)
 * - SP (0x20)
 * - Control characters (0x00-0x1F, 0x7F)
 */
function isValidEtagc(code: number): boolean {
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

/**
 * Parses a single entity-tag string.
 * Grammar: [ "W/" ] DQUOTE *etagc DQUOTE
 * Rejects:
 * - unquoted
 * - lowercase "w/"
 * - missing closing quote
 * - DQUOTE inside
 * - control characters
 * - whitespace inside quotes
 * - trailing garbage
 * - longer than 1024 characters
 */
export function parseEntityTag(raw: string | undefined): EntityTag | null {
  if (typeof raw !== 'string') return null;
  const len = raw.length;
  if (len < 2 || len > 1024) return null;

  let weak = false;
  let contentStart = 0;

  if (raw.startsWith('W/"')) {
    weak = true;
    contentStart = 3;
  } else if (raw.startsWith('w/"')) {
    // lowercase "w/" is invalid per RFC 9110 (case-sensitive)
    return null;
  } else if (raw.startsWith('"')) {
    weak = false;
    contentStart = 1;
  } else {
    return null; // Missing opening quote or invalid weak prefix
  }

  // Must end with DQUOTE
  if (raw.charCodeAt(len - 1) !== 0x22) {
    return null;
  }

  // Scan opaque characters between contentStart and len - 1
  for (let i = contentStart; i < len - 1; i++) {
    const code = raw.charCodeAt(i);
    if (!isValidEtagc(code)) {
      return null;
    }
  }

  const opaque = raw.slice(contentStart, len - 1);
  return {
    weak,
    opaque,
    raw,
  };
}

/**
 * Parses a list of entity-tags (e.g. If-None-Match or If-Match).
 * Splits on commas outside quotes, tolerates optional whitespace and empty list elements.
 * "*" is valid only as the entire value (mixed with tags is invalid).
 * Any malformed element makes the whole list invalid.
 * Uses a single-pass scanner without catastrophic regular expressions.
 */
export function parseEntityTagList(
  headerValues: string | string[] | undefined
): EntityTagListResult {
  if (headerValues === undefined) {
    return { kind: 'absent' };
  }

  const str = Array.isArray(headerValues) ? headerValues.join(',') : headerValues;
  const len = str.length;

  let inQuotes = false;
  let elemStart = 0;
  const tags: EntityTag[] = [];
  let sawStar = false;
  let sawNonEmptyElement = false;

  for (let i = 0; i <= len; i++) {
    const code = i === len ? 0x2c : str.charCodeAt(i);

    if (code === 0x22) {
      inQuotes = !inQuotes;
    } else if (code === 0x2c && !inQuotes) {
      let s = elemStart;
      let e = i;
      while (s < e && (str.charCodeAt(s) === 0x20 || str.charCodeAt(s) === 0x09)) s++;
      while (e > s && (str.charCodeAt(e - 1) === 0x20 || str.charCodeAt(e - 1) === 0x09)) e--;
      elemStart = i + 1;

      if (s === e) {
        continue;
      }

      sawNonEmptyElement = true;

      const elemLen = e - s;
      if (elemLen === 1 && str.charCodeAt(s) === 0x2a) {
        sawStar = true;
        continue;
      }
      if (elemLen < 2 || elemLen > 1024) {
        return { kind: 'invalid' };
      }

      let weak = false;
      let contentStart = s + 1;
      if (str.charCodeAt(s) === 0x57 && str.charCodeAt(s + 1) === 0x2f) {
        weak = true;
        contentStart = s + 3;
      }
      if (
        contentStart >= e ||
        str.charCodeAt(contentStart - 1) !== 0x22 ||
        str.charCodeAt(e - 1) !== 0x22
      ) {
        return { kind: 'invalid' };
      }

      let valid = true;
      for (let j = contentStart; j < e - 1; j++) {
        const c = str.charCodeAt(j);
        if (c <= 0x20 || c === 0x22 || c === 0x7f) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        return { kind: 'invalid' };
      }

      tags.push({
        weak,
        opaque: str.slice(contentStart, e - 1),
        raw: str.slice(s, e),
      });
    }
  }

  if (inQuotes || !sawNonEmptyElement) {
    return { kind: 'invalid' };
  }

  if (sawStar) {
    if (tags.length === 0 && str.replace(/[\s,]/g, '') === '*') {
      return { kind: 'star' };
    }
    return { kind: 'invalid' };
  }

  return { kind: 'tags', tags };
}

/**
 * RFC 9110 Section 8.8.3.2: Weak Comparison
 * Two entity tags are equivalent if their opaque-tags match character-by-character,
 * regardless of either or both being tagged as weak.
 */
export function weakMatch(a: EntityTag, b: EntityTag): boolean {
  return a.opaque === b.opaque;
}

/**
 * RFC 9110 Section 8.8.3.2: Strong Comparison
 * Two entity tags are equivalent if neither is weak and their opaque-tags match.
 */
export function strongMatch(a: EntityTag, b: EntityTag): boolean {
  return !a.weak && !b.weak && a.opaque === b.opaque;
}
