import http from 'node:http';
import crypto from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { normalizeUrl, InvalidPercentEncodingError } from './normalize-url.js';
import { normalizeIncomingHeaders } from './headers.js';
import { sendError } from './error-response.js';
import { ProxyError } from './errors.js';
import { validateMethod, ALLOWED_BY_DEFAULT } from './methods.js';
import { normalizeHost } from '../security/host.js';

import { Clock } from '../util/clock.js';
import { formatHttpDate } from '../cache/http-date.js';

export interface RequestParserConfig {
  maxHeaderBytes?: number; // default 16 KB (16384 bytes)
  maxBodyBytes?: number; // default 10 MB (10 * 1024 * 1024), 0 for unlimited
  allowedMethods?: readonly string[]; // default ALLOWED_BY_DEFAULT
  validateHostTargetMatch?: boolean;
  clock?: Clock;
}

import type { VerifiedClientCert } from '../tls/types.js';

export interface ProxyRequest {
  readonly id: string;
  readonly method: string;
  readonly rawTarget: string;
  readonly url: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string | string[]>;
  readonly remoteAddress: string;
  readonly receivedAt: Date;
  readonly body: Readable;
  readonly clientCert?: VerifiedClientCert;
}

const REQUEST_ID_REGEX = /^[a-zA-Z0-9_\-\.]{1,128}$/;

export function sendJsonError(
  res: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  requestId: string
): void {
  sendError({ requestId }, res, new ProxyError(code, statusCode, message));
}

export function parseRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RequestParserConfig = {}
): Promise<ProxyRequest | null> {
  const maxHeaderBytes = config.maxHeaderBytes ?? 16 * 1024;
  const maxBodyBytes = config.maxBodyBytes ?? 10 * 1024 * 1024;

  res.sendDate = false;
  if (config.clock) {
    (res as any).__clock = config.clock;
  }

  // 1. Resolve Request ID
  const incomingRequestId = req.headers['x-request-id'];
  let requestId: string;
  if (
    typeof incomingRequestId === 'string' &&
    REQUEST_ID_REGEX.test(incomingRequestId)
  ) {
    requestId = incomingRequestId;
  } else {
    requestId = crypto.randomUUID();
  }

  // Always propagate X-Request-Id on the response
  res.setHeader('X-Request-Id', requestId);

  // 2. Validate Header Size, Injection, and Sensitive Header Integrity
  let totalHeaderBytes = 0;
  let hostCount = 0;
  let authCount = 0;

  if (req.rawHeaders) {
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1] ?? '';

      // Reject header injection attempts (CR, LF, NUL)
      if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(val)) {
        sendJsonError(
          res,
          400,
          'HEADER_INJECTION',
          'Header injection attempt rejected: CR, LF, or NUL in header',
          requestId
        );
        req.resume();
        return Promise.resolve(null);
      }

      const lowerKey = key.toLowerCase();

      // Check oversized sensitive headers (limit to 8192 bytes)
      if (
        (lowerKey === 'authorization' || lowerKey === 'cookie' || lowerKey === 'x-api-key') &&
        Buffer.byteLength(val) > 8192
      ) {
        sendJsonError(
          res,
          431,
          'HEADERS_TOO_LARGE',
          `Sensitive header "${key}" exceeds maximum permitted length of 8192 bytes`,
          requestId
        );
        req.resume();
        return Promise.resolve(null);
      }

      if (lowerKey === 'host') {
        hostCount++;
      } else if (lowerKey === 'authorization') {
        authCount++;
      }

      totalHeaderBytes += Buffer.byteLength(key) + Buffer.byteLength(val) + 4; // ": " and "\r\n"
    }
  } else if (req.headers) {
    for (const [key, val] of Object.entries(req.headers)) {
      if (/[\r\n\0]/.test(key)) {
        sendJsonError(res, 400, 'HEADER_INJECTION', 'Header injection attempt rejected', requestId);
        req.resume();
        return Promise.resolve(null);
      }
      const vals = Array.isArray(val) ? val : val !== undefined ? [val] : [];
      for (const v of vals) {
        if (typeof v === 'string') {
          if (/[\r\n\0]/.test(v)) {
            sendJsonError(res, 400, 'HEADER_INJECTION', 'Header injection attempt rejected', requestId);
            req.resume();
            return Promise.resolve(null);
          }
          const lowerKey = key.toLowerCase();
          if (
            (lowerKey === 'authorization' || lowerKey === 'cookie' || lowerKey === 'x-api-key') &&
            Buffer.byteLength(v) > 8192
          ) {
            sendJsonError(res, 431, 'HEADERS_TOO_LARGE', `Header "${key}" too large`, requestId);
            req.resume();
            return Promise.resolve(null);
          }
        }
      }
    }
  }

  // Reject duplicate Authorization headers (RFC 9110 / security)
  if (
    authCount > 1 ||
    (Array.isArray(req.headers['authorization']) && req.headers['authorization'].length > 1)
  ) {
    sendJsonError(
      res,
      400,
      'DUPLICATE_HEADER',
      'Multiple Authorization headers are not allowed',
      requestId
    );
    req.resume();
    return Promise.resolve(null);
  }

  if (totalHeaderBytes > maxHeaderBytes) {
    sendJsonError(
      res,
      431,
      'HEADERS_TOO_LARGE',
      `Request headers exceed maximum size of ${maxHeaderBytes} bytes`,
      requestId
    );
    req.resume(); // drain
    return Promise.resolve(null);
  }

  // 2b. Validate Host Header (RFC 9112 Section 3.2: required on HTTP/1.1, reject multiple)
  if (!req.rawHeaders && req.headers['host'] !== undefined) {
    hostCount = Array.isArray(req.headers['host'])
      ? req.headers['host'].length
      : req.headers['host'].includes(',')
      ? 2
      : 1;
  }

  if (
    hostCount > 1 ||
    (typeof req.headers['host'] === 'string' && req.headers['host'].includes(','))
  ) {
    sendJsonError(
      res,
      400,
      'BAD_REQUEST',
      'Multiple Host headers are not allowed',
      requestId
    );
    req.resume();
    return Promise.resolve(null);
  }

  if (req.httpVersion === '1.1' && (!req.headers['host'] || hostCount === 0)) {
    sendJsonError(
      res,
      400,
      'BAD_REQUEST',
      'Host header is required for HTTP/1.1 requests',
      requestId
    );
    req.resume();
    return Promise.resolve(null);
  }

  // 3. Validate HTTP Method (RFC 9110: 405 with Allow header if known but disallowed, 501 if invalid/unknown)
  const rawMethod = req.method ?? '';
  const allowedMethods = config.allowedMethods ?? ALLOWED_BY_DEFAULT;
  const methodCheck = validateMethod(rawMethod, allowedMethods);
  if (!methodCheck.valid) {
    if (methodCheck.status === 405) {
      sendError(
        { requestId, method: rawMethod },
        res,
        new ProxyError('METHOD_NOT_ALLOWED', 405, methodCheck.message, {
          allowHeader: methodCheck.allowHeader,
        })
      );
    } else {
      sendError(
        { requestId, method: rawMethod },
        res,
        new ProxyError('NOT_IMPLEMENTED', 501, methodCheck.message)
      );
    }
    req.resume();
    return Promise.resolve(null);
  }

  const method = rawMethod;
  const rawTarget = req.url;

  // 3b. Asterisk-form "OPTIONS *": handled locally with 200 and Allow header without contacting origin
  if (method === 'OPTIONS' && (rawTarget === '*' || rawTarget === '/*')) {
    const allowHeader = allowedMethods.join(', ');
    const nowMs = config.clock ? config.clock.now() : Date.now();
    res.sendDate = false;
    res.writeHead(200, {
      Allow: allowHeader,
      'Content-Length': '0',
      'X-Request-Id': requestId,
      Date: formatHttpDate(nowMs),
    });
    res.end();
    req.resume();
    return Promise.resolve(null);
  }

  // 4. Validate and Normalize Target URL (400 Bad Request)
  if (!rawTarget) {
    sendJsonError(
      res,
      400,
      'BAD_REQUEST',
      'Target URL cannot be empty',
      requestId
    );
    req.resume();
    return Promise.resolve(null);
  }

  // 4b. Absolute-form request target must match Host header (RFC 9112 Section 3.2.1)
  if (
    config.validateHostTargetMatch &&
    (rawTarget.startsWith('http://') || rawTarget.startsWith('https://'))
  ) {
    try {
      const parsedUrl = new URL(rawTarget);
      const targetHost = normalizeHost(parsedUrl.host);
      const rawHeaderHost = req.headers['host'];
      const headerHost = rawHeaderHost ? normalizeHost(String(rawHeaderHost)) : '';
      if (headerHost && targetHost !== headerHost) {
        sendJsonError(
          res,
          400,
          'HOST_TARGET_MISMATCH',
          `Absolute request target host "${targetHost}" does not match Host header "${headerHost}"`,
          requestId
        );
        req.resume();
        return Promise.resolve(null);
      }
    } catch {
      // Invalid URL format will be caught by normalizeUrl below
    }
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeUrl(rawTarget);
  } catch (err: any) {
    const code =
      err instanceof InvalidPercentEncodingError
        ? 'INVALID_PERCENT_ENCODING'
        : 'MALFORMED_TARGET';
    sendJsonError(res, 400, code, err.message, requestId);
    req.resume();
    return Promise.resolve(null);
  }

  // 5. Validate Content-Length if present (413 Payload Too Large)
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader !== undefined && maxBodyBytes > 0) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > maxBodyBytes) {
      sendJsonError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `Payload of ${contentLength} bytes exceeds limit of ${maxBodyBytes} bytes`,
        requestId
      );
      req.resume();
      return Promise.resolve(null);
    }
  }

  // 6. Wrap body stream to enforce streaming maxBodyBytes
  let bodyStream: Readable;
  if (maxBodyBytes > 0) {
    let receivedBytes = 0;
    const bodyLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBodyBytes) {
          const err = new Error(
            `Payload exceeds maximum body size of ${maxBodyBytes} bytes`
          );
          (err as any).code = 'PAYLOAD_TOO_LARGE';
          callback(err);
          return;
        }
        callback(null, chunk);
      },
    });

    bodyLimiter.on('error', (err: any) => {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        sendJsonError(
          res,
          413,
          'PAYLOAD_TOO_LARGE',
          err.message,
          requestId
        );
      }
      req.resume();
    });

    req.pipe(bodyLimiter);
    bodyStream = bodyLimiter;
  } else {
    bodyStream = req;
  }

  // 7. Normalize headers
  const normalizedHeaders = normalizeIncomingHeaders(
    req.rawHeaders && req.rawHeaders.length > 0 ? req.rawHeaders : req.headers
  );

  const remoteAddress =
    req.socket.remoteAddress || req.connection.remoteAddress || '127.0.0.1';

  const proxyRequest: ProxyRequest = Object.freeze({
    id: requestId,
    method,
    rawTarget,
    url: normalizedUrl,
    httpVersion: req.httpVersion,
    headers: Object.freeze(normalizedHeaders),
    remoteAddress,
    receivedAt: new Date(),
    body: bodyStream,
    clientCert: (req as any).clientCert,
  });

  return Promise.resolve(proxyRequest);
}
