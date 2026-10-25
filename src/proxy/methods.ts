/**
 * HTTP Method handling module (RFC 9110).
 */

export const ALLOWED_BY_DEFAULT: readonly string[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export const KNOWN_HTTP_METHODS: readonly string[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);
const CACHEABLE_METHODS = new Set(['GET', 'HEAD']);
const KNOWN_SET = new Set(KNOWN_HTTP_METHODS);

/**
 * Checks whether an HTTP method is safe (RFC 9110 Section 9.2.1).
 * Safe methods: GET, HEAD, OPTIONS, TRACE.
 */
export function isSafe(method: string): boolean {
  return SAFE_METHODS.has(method);
}

/**
 * Checks whether an HTTP method is idempotent (RFC 9110 Section 9.2.2).
 * Idempotent methods: GET, HEAD, PUT, DELETE, OPTIONS, TRACE.
 */
export function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

/**
 * Checks whether an HTTP method is cacheable (RFC 9110 / RFC 9111).
 * Cacheable by default: GET, HEAD.
 */
export function isCacheableMethod(method: string): boolean {
  return CACHEABLE_METHODS.has(method);
}

/**
 * Checks whether an HTTP method token is a recognized RFC 9110 method.
 * Note: Method tokens are case-sensitive (e.g. "GET" is recognized, "get" is not).
 */
export function isRecognizedMethod(method: string): boolean {
  return KNOWN_SET.has(method);
}

export type MethodValidationResult =
  | { valid: true }
  | {
      valid: false;
      status: 405;
      code: 'METHOD_NOT_ALLOWED';
      allowHeader: string;
      message: string;
    }
  | {
      valid: false;
      status: 501;
      code: 'NOT_IMPLEMENTED';
      message: string;
    };

/**
 * Validates an incoming HTTP method against allowed methods.
 * - Unknown/invalid method token (or incorrect case) -> 501 Not Implemented.
 * - Known RFC 9110 method that is not allowed (e.g. TRACE, CONNECT) -> 405 Method Not Allowed with Allow header.
 */
export function validateMethod(
  method: string,
  allowedMethods: readonly string[] = ALLOWED_BY_DEFAULT
): MethodValidationResult {
  // Method tokens are case-sensitive tokens in HTTP
  if (!isRecognizedMethod(method)) {
    return {
      valid: false,
      status: 501,
      code: 'NOT_IMPLEMENTED',
      message: `HTTP method "${method}" is not implemented or invalid`,
    };
  }

  const allowedSet = new Set(allowedMethods);
  if (!allowedSet.has(method)) {
    return {
      valid: false,
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      allowHeader: allowedMethods.join(', '),
      message: `HTTP method "${method}" is not allowed`,
    };
  }

  return { valid: true };
}
