export interface KeyNormalizationOptions {
  sortQuery?: boolean; // default true
  ignoreQueryParams?: string[]; // default []
  ignoreQuery?: boolean; // default false
}

interface ParsedParam {
  name: string;
  raw: string;
}

/**
 * Normalizes query string for cache key generation.
 * Operates purely on raw strings without URL-decoding (%26 stays %26, + is not converted to space).
 */
export function normalizeQueryForKey(
  rawQuery: string,
  options: KeyNormalizationOptions = {}
): string {
  if (options.ignoreQuery) {
    return '';
  }

  if (!rawQuery) {
    return '';
  }

  // Strip leading '?' if present
  let q = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (!q) {
    return '';
  }

  const sortQuery = options.sortQuery ?? true;
  const ignorePatterns = options.ignoreQueryParams ?? [];

  // Split on '&' and drop empty segments
  const rawParts = q.split('&');
  const params: ParsedParam[] = [];

  for (const part of rawParts) {
    if (!part) continue;

    const eqIdx = part.indexOf('=');
    const name = eqIdx === -1 ? part : part.substring(0, eqIdx);

    // Check if name matches any ignore pattern (exact or prefix with *)
    let shouldIgnore = false;
    for (const pattern of ignorePatterns) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (name.startsWith(prefix)) {
          shouldIgnore = true;
          break;
        }
      } else {
        if (name === pattern) {
          shouldIgnore = true;
          break;
        }
      }
    }

    if (!shouldIgnore) {
      params.push({ name, raw: part });
    }
  }

  if (params.length === 0) {
    return '';
  }

  // Stable sort by parameter name
  if (sortQuery) {
    params.sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
  }

  return params.map((p) => p.raw).join('&');
}
