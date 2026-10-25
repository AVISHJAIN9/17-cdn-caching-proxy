/**
 * RFC 3986 Section 6 URL Normalization
 * PURE function with no I/O.
 */

export class InvalidPercentEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPercentEncodingError';
  }
}

// Unreserved characters: ALPHA / DIGIT / "-" / "." / "_" / "~"
function isUnreserved(byteVal: number): boolean {
  return (
    (byteVal >= 0x41 && byteVal <= 0x5a) || // A-Z
    (byteVal >= 0x61 && byteVal <= 0x7a) || // a-z
    (byteVal >= 0x30 && byteVal <= 0x39) || // 0-9
    byteVal === 0x2d || // -
    byteVal === 0x2e || // .
    byteVal === 0x5f || // _
    byteVal === 0x7e // ~
  );
}

/**
 * Normalizes percent-encoding in a string:
 * - Validates percent encoding syntax (% followed by two hex digits). Throws InvalidPercentEncodingError if invalid.
 * - Decodes unreserved characters (%41 -> 'A', %7e -> '~', etc.).
 * - Uppercases percent-encoded hex digits for reserved/other bytes (%2f -> %2F).
 */
export function normalizePercentEncoding(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '%') {
      if (i + 2 >= str.length) {
        throw new InvalidPercentEncodingError(
          `Incomplete percent-encoding at end of string: "${str.slice(i)}"`
        );
      }
      const hex = str.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new InvalidPercentEncodingError(
          `Invalid percent-encoding hex digits "%${hex}" in "${str}"`
        );
      }
      const byteVal = parseInt(hex, 16);
      if (isUnreserved(byteVal)) {
        result += String.fromCharCode(byteVal);
      } else {
        result += '%' + hex.toUpperCase();
      }
      i += 2;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * RFC 3986 Section 5.2.4: Remove Dot Segments
 * Resolves /./ and /../ without collapsing double slashes or altering unreserved query chars.
 */
export function removeDotSegments(path: string): string {
  let input = path;
  let output = '';

  while (input.length > 0) {
    // A. If the input buffer begins with a prefix of "../" or "./",
    //    then remove that prefix from the input buffer;
    if (input.startsWith('../')) {
      input = input.slice(3);
    } else if (input.startsWith('./')) {
      input = input.slice(2);
    }
    // B. if the input buffer begins with a prefix of "/./" or "/.",
    //    where "." is a complete path segment, then replace that
    //    prefix with "/" in the input buffer;
    else if (input.startsWith('/./')) {
      input = '/' + input.slice(3);
    } else if (input === '/.') {
      input = '/';
    }
    // C. if the input buffer begins with a prefix of "/../" or "/..",
    //    where ".." is a complete path segment, then replace that
    //    prefix with "/" in the input buffer and remove the last
    //    segment and its preceding "/" (if any) from the output buffer;
    else if (input.startsWith('/../')) {
      input = '/' + input.slice(4);
      output = removeLastSegment(output);
    } else if (input === '/..') {
      input = '/';
      output = removeLastSegment(output);
    }
    // D. if the input buffer consists only of "." or "..", then remove that from the input buffer;
    else if (input === '.' || input === '..') {
      input = '';
    }
    // E. move the first path segment in the input buffer to the end of the output buffer,
    //    including the initial "/" character (if any) and any subsequent characters up to,
    //    but not including, the next "/" character or the end of the input buffer.
    else {
      let nextSlash = -1;
      if (input.startsWith('/')) {
        nextSlash = input.indexOf('/', 1);
      } else {
        nextSlash = input.indexOf('/');
      }

      if (nextSlash === -1) {
        output += input;
        input = '';
      } else {
        output += input.slice(0, nextSlash);
        input = input.slice(nextSlash);
      }
    }
  }

  return output;
}

function removeLastSegment(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return '';
  }
  return path.slice(0, lastSlash);
}

/**
 * Normalizes a URL string per RFC 3986 section 6:
 * - Lowercase scheme and host
 * - Remove default ports (80 for http, 443 for https)
 * - Resolve dot segments (/a/./b/../c -> /a/c)
 * - Uppercase percent-encoding hex digits (%2f -> %2F)
 * - Decode percent-encoded unreserved characters (%41 -> A, but keep %2F as %2F)
 * - Empty path becomes "/"
 * - Remove the fragment
 * - Do NOT reorder or drop query parameters
 * - Do NOT collapse double slashes
 * - Throws InvalidPercentEncodingError on invalid percent-encoding
 */
export function normalizeUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string') {
    throw new Error('URL must be a string');
  }
  if (rawUrl.length === 0) {
    return '/';
  }

  // Remove fragment if present
  const hashIdx = rawUrl.indexOf('#');
  let urlWithoutHash = hashIdx !== -1 ? rawUrl.slice(0, hashIdx) : rawUrl;

  // Check if absolute-form: starts with scheme (e.g. "http://" or "https://")
  const schemeMatch = urlWithoutHash.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);

  if (schemeMatch) {
    const rawScheme = schemeMatch[1];
    const scheme = rawScheme.toLowerCase();
    const rest = schemeMatch[2];

    // Find authority boundary: authority ends at first '/', '?', or end of string
    let authorityEnd = rest.search(/[/?]/);
    let authority = authorityEnd !== -1 ? rest.slice(0, authorityEnd) : rest;
    let pathAndQuery = authorityEnd !== -1 ? rest.slice(authorityEnd) : '';

    // Handle userinfo if present in authority
    let userInfo = '';
    let hostPort = authority;
    const atIdx = authority.indexOf('@');
    if (atIdx !== -1) {
      userInfo = authority.slice(0, atIdx + 1);
      hostPort = authority.slice(atIdx + 1);
    }

    // Host & port parsing (supporting IPv6 enclosed in [...])
    let host = hostPort;
    let port = '';

    if (hostPort.startsWith('[')) {
      // IPv6 literal
      const closingBracket = hostPort.indexOf(']');
      if (closingBracket !== -1) {
        host = hostPort.slice(0, closingBracket + 1).toLowerCase();
        const afterBracket = hostPort.slice(closingBracket + 1);
        if (afterBracket.startsWith(':')) {
          port = afterBracket.slice(1);
        }
      }
    } else {
      const colonIdx = hostPort.lastIndexOf(':');
      if (colonIdx !== -1) {
        host = hostPort.slice(0, colonIdx).toLowerCase();
        port = hostPort.slice(colonIdx + 1);
      } else {
        host = hostPort.toLowerCase();
      }
    }

    // Normalize percent-encoding in host
    host = normalizePercentEncoding(host);

    // Remove default ports (80 for http, 443 for https)
    let portSuffix = '';
    if (port) {
      if ((scheme === 'http' && port === '80') || (scheme === 'https' && port === '443')) {
        portSuffix = '';
      } else {
        portSuffix = ':' + port;
      }
    }

    // Path & Query
    let path = '';
    let query = '';
    const qIdx = pathAndQuery.indexOf('?');
    if (qIdx !== -1) {
      path = pathAndQuery.slice(0, qIdx);
      query = pathAndQuery.slice(qIdx); // includes '?'
    } else {
      path = pathAndQuery;
    }

    // Empty path becomes "/"
    if (!path) {
      path = '/';
    }

    // Normalize path percent-encoding first, then dot segments
    path = normalizePercentEncoding(path);
    path = removeDotSegments(path);
    if (!path.startsWith('/')) {
      path = '/' + path;
    }

    // Normalize query percent-encoding (without reordering or touching query structure)
    if (query) {
      query = '?' + normalizePercentEncoding(query.slice(1));
    }

    return `${scheme}://${userInfo}${host}${portSuffix}${path}${query}`;
  } else {
    // Origin-form target (e.g. "/path?q=1" or "path")
    let pathAndQuery = urlWithoutHash;
    let path = '';
    let query = '';
    const qIdx = pathAndQuery.indexOf('?');
    if (qIdx !== -1) {
      path = pathAndQuery.slice(0, qIdx);
      query = pathAndQuery.slice(qIdx);
    } else {
      path = pathAndQuery;
    }

    if (!path) {
      path = '/';
    }

    // Normalize percent-encoding and dot-segments
    path = normalizePercentEncoding(path);
    const wasAbsolute = path.startsWith('/');
    path = removeDotSegments(path);
    if (wasAbsolute && !path.startsWith('/')) {
      path = '/' + path;
    } else if (!wasAbsolute && !path) {
      path = '/';
    }

    if (query) {
      query = '?' + normalizePercentEncoding(query.slice(1));
    }

    return `${path}${query}`;
  }
}
