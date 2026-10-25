import http from 'node:http';

export class UpstreamResponseError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 502) {
    super(message);
    this.name = 'UpstreamResponseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ParsedResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string | string[]>;
  readonly setCookies: string[];
  readonly contentLength: number | null;
  readonly isChunked: boolean;
  readonly hasBody: boolean;
  readonly receivedAt: number;
  readonly isInterim: boolean;
}

export interface ParseResponseOptions {
  requestMethod: string;
  receivedAt?: number;
  isFinal?: boolean; // default true
}

/**
 * Parses and validates an upstream HTTP response into a typed, immutable ParsedResponse.
 * Throws UpstreamResponseError with code UPSTREAM_INVALID_RESPONSE (502) if response framing or status is invalid.
 */
export function parseUpstreamResponse(
  originRes: {
    statusCode?: number;
    statusMessage?: string;
    httpVersion?: string;
    headers: http.IncomingHttpHeaders;
    rawHeaders?: string[];
  },
  options: ParseResponseOptions
): ParsedResponse {
  const receivedAt = options.receivedAt ?? Date.now();
  const method = options.requestMethod.toUpperCase();
  const statusCode = originRes.statusCode ?? 0;
  const statusMessage = originRes.statusMessage ?? (http.STATUS_CODES[statusCode] || '');
  const httpVersion = originRes.httpVersion ?? '1.1';
  const isFinal = options.isFinal ?? true;

  // 1. Validate status code range (200 - 599 once final; 100 - 199 if interim)
  if (isFinal) {
    if (statusCode < 200 || statusCode > 599) {
      throw new UpstreamResponseError(
        'UPSTREAM_INVALID_RESPONSE',
        `Invalid upstream final status code: ${statusCode} (must be 200-599)`
      );
    }
  } else {
    if (statusCode < 100 || statusCode >= 200) {
      throw new UpstreamResponseError(
        'UPSTREAM_INVALID_RESPONSE',
        `Invalid upstream interim status code: ${statusCode} (must be 100-199)`
      );
    }
  }

  const isInterim = statusCode >= 100 && statusCode < 200;

  // 2. Normalize headers: lowercase keys, set-cookie kept as array
  const normalizedHeaders: Record<string, string | string[]> = {};
  const setCookies: string[] = [];

  for (const [key, val] of Object.entries(originRes.headers)) {
    if (val === undefined) continue;
    const lowerKey = key.toLowerCase();

    if (lowerKey === 'set-cookie') {
      if (Array.isArray(val)) {
        setCookies.push(...val);
      } else if (typeof val === 'string') {
        setCookies.push(val);
      }
    } else {
      normalizedHeaders[lowerKey] = val;
    }
  }

  if (setCookies.length > 0) {
    normalizedHeaders['set-cookie'] = [...setCookies];
  }

  // 3. Inspect Transfer-Encoding
  const teVal = normalizedHeaders['transfer-encoding'];
  let isChunked = false;
  if (typeof teVal === 'string') {
    isChunked = teVal.toLowerCase().includes('chunked');
  } else if (Array.isArray(teVal)) {
    isChunked = teVal.some((t) => t.toLowerCase().includes('chunked'));
  }

  // 4. Inspect Content-Length
  let contentLength: number | null = null;
  const rawCl = normalizedHeaders['content-length'];

  if (rawCl !== undefined) {
    let clValues: string[] = [];
    if (Array.isArray(rawCl)) {
      clValues = rawCl.flatMap((v) => v.split(',').map((s) => s.trim()));
    } else if (typeof rawCl === 'string') {
      clValues = rawCl.split(',').map((s) => s.trim());
    }

    if (clValues.length > 0) {
      // Check for conflicting multiple content-length values
      const firstVal = clValues[0];
      for (const val of clValues) {
        if (val !== firstVal) {
          throw new UpstreamResponseError(
            'UPSTREAM_INVALID_RESPONSE',
            `Conflicting Content-Length headers received: [${clValues.join(', ')}]`
          );
        }
      }

      // Check numeric validity
      if (!/^\d+$/.test(firstVal)) {
        throw new UpstreamResponseError(
          'UPSTREAM_INVALID_RESPONSE',
          `Non-numeric Content-Length header received: "${firstVal}"`
        );
      }

      const parsedNum = Number(firstVal);
      if (!Number.isSafeInteger(parsedNum) || parsedNum < 0) {
        throw new UpstreamResponseError(
          'UPSTREAM_INVALID_RESPONSE',
          `Negative or invalid Content-Length: "${firstVal}"`
        );
      }

      contentLength = parsedNum;
    }
  }

  // If both Content-Length and Transfer-Encoding: chunked are present,
  // chunked wins and Content-Length is ignored for framing; log a warning.
  if (isChunked && contentLength !== null) {
    console.warn(
      `[parse-response] Upstream sent both Transfer-Encoding: chunked and Content-Length (${contentLength}). Chunked wins; Content-Length ignored for framing.`
    );
    contentLength = null;
  }

  // 5. Compute hasBody per RFC 9110:
  // false for HEAD requests, 1xx informational, 204 No Content, 304 Not Modified
  const isBodyless =
    method === 'HEAD' ||
    isInterim ||
    statusCode === 204 ||
    statusCode === 304;

  const hasBody = !isBodyless;

  const parsed: ParsedResponse = {
    statusCode,
    statusMessage,
    httpVersion,
    headers: Object.freeze(normalizedHeaders),
    setCookies: Object.freeze(setCookies) as unknown as string[],
    contentLength,
    isChunked,
    hasBody,
    receivedAt,
    isInterim,
  };

  return Object.freeze(parsed);
}
