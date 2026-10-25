/**
 * RFC 9111 Cache-Control header parser.
 * Pure function: parseCacheControl(headerValues) -> ParsedCacheControl.
 */

export interface ParsedCacheControl {
  noStore: boolean;
  noCache: boolean;
  noCacheFields?: string[];
  private: boolean;
  privateFields?: string[];
  public: boolean;
  mustRevalidate: boolean;
  proxyRevalidate: boolean;
  noTransform: boolean;
  immutable: boolean;
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  minFresh?: number;
  maxStale?: number | true;
  onlyIfCached: boolean;
  extensions: Record<string, string | true>;
  invalid: string[];
}

const MAX_DELTA_SECONDS = 2147483648; // RFC 9111 Section 1.2.2 cap (2^31)

/**
 * Parses delta-seconds according to RFC 9111:
 * - Digits only
 * - Non-numeric, negative, empty, decimal, or "+" sign is INVALID
 * - Above 2147483648 capped at 2147483648
 * Returns parsed number or null if invalid.
 */
function parseDeltaSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 48 || code > 57) {
      return null;
    }
  }

  if (raw.length > 10) {
    return MAX_DELTA_SECONDS;
  }
  const val = Number(raw);
  if (!Number.isFinite(val) || val > MAX_DELTA_SECONDS) {
    return MAX_DELTA_SECONDS;
  }
  return val;
}

/**
 * Splits comma-separated field names (e.g. inside no-cache="set-cookie, a")
 */
function parseFieldList(raw: string): string[] {
  return raw
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 0);
}

/**
 * Fast single-pass scanner to parse directives without intermediate arrays.
 */
function scanDirectives(
  input: string,
  onDirective: (name: string, rawValue?: string) => void
): void {
  const len = input.length;
  let i = 0;

  while (i < len) {
    // 1. Skip leading commas and whitespace
    while (i < len) {
      const code = input.charCodeAt(i);
      if (code === 44 || code <= 32) {
        i++;
      } else {
        break;
      }
    }
    if (i >= len) break;

    // 2. Scan directive name until '=', ',', or whitespace
    const nameStart = i;
    while (i < len) {
      const code = input.charCodeAt(i);
      if (code === 61 || code === 44 || code <= 32) {
        break;
      }
      i++;
    }
    const name = input.substring(nameStart, i).toLowerCase();

    // 3. Skip whitespace after name
    while (i < len && input.charCodeAt(i) <= 32) {
      i++;
    }

    if (i >= len || input.charCodeAt(i) === 44) {
      if (i < len && input.charCodeAt(i) === 44) i++;
      onDirective(name, undefined);
      continue;
    }

    if (input.charCodeAt(i) === 61) {
      i++; // skip '='
      // Skip whitespace after '='
      while (i < len && input.charCodeAt(i) <= 32) {
        i++;
      }

      if (i >= len) {
        onDirective(name, '');
        break;
      }

      let rawVal: string;
      if (input.charCodeAt(i) === 34) {
        // Quoted string
        i++; // skip opening quote
        const valStart = i;
        let hasEscapes = false;
        while (i < len) {
          const code = input.charCodeAt(i);
          if (code === 92) {
            // Backslash escape
            hasEscapes = true;
            i += 2;
          } else if (code === 34) {
            // Closing quote
            break;
          } else {
            i++;
          }
        }

        if (!hasEscapes) {
          rawVal = input.substring(valStart, i);
        } else {
          let val = '';
          let j = valStart;
          while (j < i) {
            if (input.charCodeAt(j) === 92 && j + 1 < i) {
              val += input[j + 1];
              j += 2;
            } else {
              val += input[j];
              j++;
            }
          }
          rawVal = val;
        }

        if (i < len && input.charCodeAt(i) === 34) {
          i++; // skip closing quote
        }
        // Skip until comma or end
        while (i < len && input.charCodeAt(i) !== 44) {
          i++;
        }
        if (i < len && input.charCodeAt(i) === 44) i++;
      } else {
        // Token value until comma
        const valStart = i;
        while (i < len && input.charCodeAt(i) !== 44) {
          i++;
        }
        rawVal = input.substring(valStart, i).trim();
        if (i < len && input.charCodeAt(i) === 44) i++;
      }

      onDirective(name, rawVal);
    } else {
      onDirective(name, undefined);
    }
  }
}

export function parseCacheControl(headerValues: string | string[] | undefined): ParsedCacheControl {
  const result: ParsedCacheControl = {
    noStore: false,
    noCache: false,
    private: false,
    public: false,
    mustRevalidate: false,
    proxyRevalidate: false,
    noTransform: false,
    immutable: false,
    onlyIfCached: false,
    extensions: {},
    invalid: [],
  };

  if (!headerValues) {
    return result;
  }

  const fullHeader = Array.isArray(headerValues) ? headerValues.join(',') : headerValues;
  if (!fullHeader || fullHeader.trim().length === 0) {
    return result;
  }

  const seenDirectives = new Map<string, string | undefined>();

  scanDirectives(fullHeader, (name, rawValue) => {
    if (!name) return;

    // Check duplicate directive conflict
    if (seenDirectives.has(name)) {
      const prevVal = seenDirectives.get(name);
      if (prevVal !== rawValue) {
        // Conflicting duplicate! Per RFC 9111 Section 4.2.1, treat response as stale (value 0)
        if (!result.invalid.includes(name)) {
          result.invalid.push(name);
        }
        if (name === 'max-age') result.maxAge = 0;
        else if (name === 's-maxage') result.sMaxAge = 0;
        else if (name === 'stale-while-revalidate') result.staleWhileRevalidate = 0;
        else if (name === 'stale-if-error') result.staleIfError = 0;
        else if (name === 'min-fresh') result.minFresh = 0;
        else if (name === 'max-stale') result.maxStale = 0;
        return;
      }
      // Identical duplicate - ignore redundant entry
      return;
    }
    seenDirectives.set(name, rawValue);

    switch (name) {
      case 'no-store':
        result.noStore = true;
        break;

      case 'no-cache':
        result.noCache = true;
        if (rawValue !== undefined && rawValue.length > 0) {
          result.noCacheFields = parseFieldList(rawValue);
        }
        break;

      case 'private':
        result.private = true;
        if (rawValue !== undefined && rawValue.length > 0) {
          result.privateFields = parseFieldList(rawValue);
        }
        break;

      case 'public':
        result.public = true;
        break;

      case 'must-revalidate':
        result.mustRevalidate = true;
        break;

      case 'proxy-revalidate':
        result.proxyRevalidate = true;
        break;

      case 'no-transform':
        result.noTransform = true;
        break;

      case 'immutable':
        result.immutable = true;
        break;

      case 'only-if-cached':
        result.onlyIfCached = true;
        break;

      case 'max-age': {
        const parsed = parseDeltaSeconds(rawValue);
        if (parsed === null) {
          result.invalid.push(name);
          result.maxAge = 0;
        } else {
          result.maxAge = parsed;
        }
        break;
      }

      case 's-maxage': {
        const parsed = parseDeltaSeconds(rawValue);
        if (parsed === null) {
          result.invalid.push(name);
          result.sMaxAge = 0;
        } else {
          result.sMaxAge = parsed;
        }
        break;
      }

      case 'stale-while-revalidate': {
        const parsed = parseDeltaSeconds(rawValue);
        if (parsed === null) {
          result.invalid.push(name);
          result.staleWhileRevalidate = 0;
        } else {
          result.staleWhileRevalidate = parsed;
        }
        break;
      }

      case 'stale-if-error': {
        const parsed = parseDeltaSeconds(rawValue);
        if (parsed === null) {
          result.invalid.push(name);
          result.staleIfError = 0;
        } else {
          result.staleIfError = parsed;
        }
        break;
      }

      case 'min-fresh': {
        const parsed = parseDeltaSeconds(rawValue);
        if (parsed === null) {
          result.invalid.push(name);
          result.minFresh = 0;
        } else {
          result.minFresh = parsed;
        }
        break;
      }

      case 'max-stale': {
        if (rawValue === undefined || rawValue === '') {
          result.maxStale = true;
        } else {
          const parsed = parseDeltaSeconds(rawValue);
          if (parsed === null) {
            result.invalid.push(name);
            result.maxStale = 0;
          } else {
            result.maxStale = parsed;
          }
        }
        break;
      }

      default:
        result.extensions[name] = rawValue !== undefined ? rawValue : true;
        break;
    }
  });

  return result;
}
