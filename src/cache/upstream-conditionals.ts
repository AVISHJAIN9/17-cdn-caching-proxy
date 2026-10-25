export interface UpstreamConditionals {
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  hasValidators: boolean;
}

/**
 * Builds RFC 9111 upstream conditional revalidation headers from a stored cache entry.
 * - If-None-Match = etagRaw exactly as stored (weak tags permitted on GET).
 * - If-Modified-Since = lastModifiedRaw exactly as stored.
 * - Both headers sent if both validators exist (RFC 9111 §4.3.1).
 * - hasValidators is false if neither validator is available.
 */
export function buildUpstreamConditionals(entry: {
  etagRaw?: string;
  lastModifiedRaw?: string;
}): UpstreamConditionals {
  const ifNoneMatch =
    typeof entry.etagRaw === 'string' && entry.etagRaw.length > 0 ? entry.etagRaw : undefined;
  const ifModifiedSince =
    typeof entry.lastModifiedRaw === 'string' && entry.lastModifiedRaw.length > 0
      ? entry.lastModifiedRaw
      : undefined;
  const hasValidators = ifNoneMatch !== undefined || ifModifiedSince !== undefined;

  return {
    ifNoneMatch,
    ifModifiedSince,
    hasValidators,
  };
}
