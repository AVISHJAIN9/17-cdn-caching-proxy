import { formatHttpDate, parseHttpDate } from '../cache/http-date.js';

export interface ResolveDateResult {
  dateHeaderValue: string;
  dateSource: 'origin' | 'proxy_added';
  dateValueMs: number;
  logEvent?: 'date_missing' | 'date_invalid';
}

/**
 * Resolves Date header according to Batch 6 Date rules:
 * Rule a: Proxied response (MISS path and plain pass-through):
 * - If the origin sent exactly ONE Date header that parseHttpDate accepts, forward it unchanged.
 * - If Date is missing, invalid, or appears more than once, REPLACE it with formatHttpDate(responseReceivedTime)
 *   from the injected Clock (log date_missing or date_invalid with the requestId). Never send two Date headers.
 */
export function resolveOriginResponseDate(
  dateHeader: string | string[] | undefined,
  rawHeaders: string[] | undefined,
  responseReceivedTime: number,
  requestId?: string
): ResolveDateResult {
  // Check if multiple Date header lines appeared in rawHeaders
  let dateOccurrenceCount = 0;
  if (rawHeaders) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'date') {
        dateOccurrenceCount++;
      }
    }
  } else if (Array.isArray(dateHeader)) {
    dateOccurrenceCount = dateHeader.length;
  } else if (dateHeader !== undefined) {
    dateOccurrenceCount = 1;
  }

  // 1. Missing Date
  if (dateOccurrenceCount === 0 || dateHeader === undefined) {
    console.warn(`date_missing: origin sent no Date header requestId=${requestId ?? 'unknown'}`);
    return {
      dateHeaderValue: formatHttpDate(responseReceivedTime),
      dateSource: 'proxy_added',
      dateValueMs: responseReceivedTime,
      logEvent: 'date_missing',
    };
  }

  // 2. Multiple Date headers
  if (dateOccurrenceCount > 1) {
    console.warn(`date_invalid: origin sent multiple Date headers requestId=${requestId ?? 'unknown'}`);
    return {
      dateHeaderValue: formatHttpDate(responseReceivedTime),
      dateSource: 'proxy_added',
      dateValueMs: responseReceivedTime,
      logEvent: 'date_invalid',
    };
  }

  // 3. Exactly one Date header
  const singleDate = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
  const parsedMs = parseHttpDate(singleDate);
  if (parsedMs === null) {
    console.warn(`date_invalid: origin Date header '${singleDate}' is invalid requestId=${requestId ?? 'unknown'}`);
    return {
      dateHeaderValue: formatHttpDate(responseReceivedTime),
      dateSource: 'proxy_added',
      dateValueMs: responseReceivedTime,
      logEvent: 'date_invalid',
    };
  }

  return {
    dateHeaderValue: singleDate,
    dateSource: 'origin',
    dateValueMs: parsedMs,
  };
}
