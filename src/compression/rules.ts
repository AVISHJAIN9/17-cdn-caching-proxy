export interface ContentTypeRulesConfig {
  allow?: (string | RegExp)[];
  deny?: (string | RegExp)[];
}

/**
 * Normalizes a Content-Type header value by stripping media parameters (e.g. charset)
 * and converting to lower case.
 */
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return '';
  const idx = contentType.indexOf(';');
  const base = idx >= 0 ? contentType.slice(0, idx) : contentType;
  return base.trim().toLowerCase();
}

const DEFAULT_COMPRESSIBLE_PATTERNS: RegExp[] = [
  /^text\//,
  /^application\/json$/,
  /^application\/(?:.+\+)?json$/,
  /^application\/xml$/,
  /^text\/xml$/,
  /^application\/(?:.+\+)?xml$/,
  /^application\/javascript$/,
  /^application\/x-javascript$/,
  /^application\/wasm$/,
  /^image\/svg\+xml$/,
];

const DEFAULT_INCOMPRESSIBLE_PATTERNS: RegExp[] = [
  /^image\/(?!svg\+xml).+/,
  /^video\//,
  /^audio\//,
  /^font\/woff2?$/,
  /^application\/(?:font-)?woff2?$/,
  /^application\/(?:zip|gzip|x-rar-compressed|x-7z-compressed|x-tar|pdf|octet-stream)$/,
];

/**
 * Determines whether the given Content-Type is compressible according to
 * allow/deny configuration and default media type rules.
 */
export function isCompressibleContentType(
  contentType: string | undefined,
  config?: ContentTypeRulesConfig
): boolean {
  const normalized = normalizeContentType(contentType);
  if (!normalized || !normalized.includes('/')) {
    // Missing or invalid format defaults to incompressible
    return false;
  }

  // 1. Deny list takes precedence over everything
  if (config?.deny) {
    for (const rule of config.deny) {
      if (typeof rule === 'string' ? rule.toLowerCase() === normalized : rule.test(normalized)) {
        return false;
      }
    }
  }

  // 2. Allow list takes precedence over default incompressible patterns
  if (config?.allow) {
    for (const rule of config.allow) {
      if (typeof rule === 'string' ? rule.toLowerCase() === normalized : rule.test(normalized)) {
        return true;
      }
    }
  }

  // 3. Default incompressible patterns (images, audio, video, archives, woff2)
  for (const pattern of DEFAULT_INCOMPRESSIBLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return false;
    }
  }

  // 4. Default compressible patterns (text, json, xml, js, svg, wasm)
  for (const pattern of DEFAULT_COMPRESSIBLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Any other unrecognized type defaults to false
  return false;
}
