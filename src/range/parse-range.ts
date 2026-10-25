/**
 * RFC 9110 §14.1.2 Range Requests and §13.1.5 If-Range Parser
 */

export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export type ParseRangeResult =
  | { type: 'valid'; ranges: ByteRange[] }
  | { type: 'unsatisfiable'; total: number }
  | { type: 'malformed' }
  | { type: 'none' };

/**
 * Parses an HTTP Range header (e.g. "bytes=0-499", "bytes=500-", "bytes=-500").
 * Returns valid ranges, unsatisfiable, malformed, or none.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalLength: number
): ParseRangeResult {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return { type: 'none' };
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) {
    return { type: 'malformed' };
  }

  const specifiers = trimmed.slice(6).trim();
  if (!specifiers) {
    return { type: 'malformed' };
  }

  const parts = specifiers.split(',');
  const validRanges: ByteRange[] = [];

  for (const part of parts) {
    const raw = part.trim();
    if (!raw) continue;

    const dashIdx = raw.indexOf('-');
    if (dashIdx === -1) {
      return { type: 'malformed' };
    }

    const startStr = raw.slice(0, dashIdx).trim();
    const endStr = raw.slice(dashIdx + 1).trim();

    if (startStr === '' && endStr === '') {
      return { type: 'malformed' };
    }

    if (startStr === '') {
      // Suffix range: "-suffix"
      if (!/^\d+$/.test(endStr)) {
        return { type: 'malformed' };
      }
      const suffixLen = parseInt(endStr, 10);
      if (suffixLen <= 0) {
        return { type: 'unsatisfiable', total: totalLength };
      }
      if (totalLength === 0) {
        return { type: 'unsatisfiable', total: totalLength };
      }
      const start = Math.max(0, totalLength - suffixLen);
      const end = totalLength - 1;
      validRanges.push({ start, end, length: end - start + 1 });
    } else if (endStr === '') {
      // Open-ended range: "start-"
      if (!/^\d+$/.test(startStr)) {
        return { type: 'malformed' };
      }
      const start = parseInt(startStr, 10);
      if (start >= totalLength || totalLength === 0) {
        return { type: 'unsatisfiable', total: totalLength };
      }
      const end = totalLength - 1;
      validRanges.push({ start, end, length: end - start + 1 });
    } else {
      // Closed range: "start-end"
      if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) {
        return { type: 'malformed' };
      }
      const start = parseInt(startStr, 10);
      let end = parseInt(endStr, 10);
      if (start > end) {
        return { type: 'malformed' };
      }
      if (start >= totalLength || totalLength === 0) {
        return { type: 'unsatisfiable', total: totalLength };
      }
      if (end >= totalLength) {
        end = totalLength - 1;
      }
      validRanges.push({ start, end, length: end - start + 1 });
    }
  }

  if (validRanges.length === 0) {
    return { type: 'unsatisfiable', total: totalLength };
  }

  return { type: 'valid', ranges: validRanges };
}

/**
 * Evaluates If-Range validator per RFC 9110 §13.1.5.
 * Returns true if the range request should be fulfilled (validator matched).
 * Returns false if validator mismatched and the full response should be served.
 */
export function evaluateIfRange(
  ifRangeHeader: string | undefined,
  currentEtag: string | undefined,
  currentLastModified: string | undefined
): boolean {
  if (!ifRangeHeader) {
    return true; // No If-Range -> range request applies directly
  }

  const trimmed = ifRangeHeader.trim();

  // If-Range with ETag: must be a strong validator
  if (trimmed.startsWith('"') || trimmed.startsWith('W/')) {
    if (trimmed.startsWith('W/')) {
      // RFC 9110 §13.1.5: An entity tag in If-Range MUST NOT be a weak entity tag
      return false;
    }
    if (!currentEtag) return false;
    // Strong comparison
    return currentEtag === trimmed;
  }

  // If-Range with HTTP-Date
  const ifRangeDate = Date.parse(trimmed);
  if (isNaN(ifRangeDate) || !currentLastModified) {
    return false;
  }

  const currentModDate = Date.parse(currentLastModified);
  if (isNaN(currentModDate)) {
    return false;
  }

  // If last-modified is exactly equal to the If-Range date, matches
  return currentModDate <= ifRangeDate;
}
