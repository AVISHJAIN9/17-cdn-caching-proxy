import { parseHttpDate } from './http-date.js';

/**
 * Resolves the Last-Modified validator from origin response headers.
 * Per RFC 9110 / RFC 9111:
 * - Exactly ONE Last-Modified header that parses into an HTTP date -> valid lastModifiedMs
 * - Multiple Last-Modified headers -> unusable validator (log last_modified_multiple)
 * - Malformed Last-Modified header -> unusable validator (log last_modified_invalid)
 * - Missing -> undefined
 */
export function resolveResponseLastModifiedInfo(
  lmHeader: string | string[] | undefined,
  rawHeaders: string[] | undefined,
  requestId?: string
): { ms: number; raw: string } | undefined {
  let count = 0;
  if (rawHeaders) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'last-modified') {
        count++;
      }
    }
  } else if (Array.isArray(lmHeader)) {
    count = lmHeader.length;
  } else if (lmHeader !== undefined) {
    count = 1;
  }

  if (count === 0 || lmHeader === undefined) {
    return undefined;
  }

  if (count > 1) {
    console.warn(`last_modified_multiple: origin sent multiple Last-Modified headers requestId=${requestId ?? 'unknown'}`);
    return undefined;
  }

  const raw = Array.isArray(lmHeader) ? lmHeader[0] : lmHeader;
  const parsed = parseHttpDate(raw);
  if (parsed === null) {
    console.warn(`last_modified_invalid: origin Last-Modified header '${raw}' is invalid requestId=${requestId ?? 'unknown'}`);
    return undefined;
  }

  return { ms: parsed, raw };
}

export function resolveResponseLastModified(
  lmHeader: string | string[] | undefined,
  rawHeaders: string[] | undefined,
  requestId?: string
): number | undefined {
  return resolveResponseLastModifiedInfo(lmHeader, rawHeaders, requestId)?.ms;
}

