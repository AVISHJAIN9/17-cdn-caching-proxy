/**
 * RFC 9110 Header Normalization & Proxy Hop-by-Hop Stripping
 */

export interface HeaderNormalizationOptions {
  clientIp?: string;
  isTls?: boolean;
  originHost?: string;
  preserveHost?: boolean;
  trustForwardedHeaders?: boolean;
  proxyVia?: string; // default "1.1 cdn-proxy"
  internalHeaders?: Record<string, string | string[]>;
}

// Hop-by-hop headers per RFC 9110 / RFC 2616
const STANDARD_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

const INTERNAL_HEADER_PREFIXES = [
  'x-forwarded-',
  'x-tenant',
  'x-client-',
  'x-origin-',
  'x-internal-',
  'x-proxy-',
  'x-verified-',
];

export function isInternalHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  return INTERNAL_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Normalizes incoming request headers from raw/parsed representation:
 * - Lowercases all header names
 * - Handles duplicate headers correctly (comma-joining allowed headers, keeping Set-Cookie as array)
 */
export function normalizeIncomingHeaders(
  rawHeaders: NodeJS.Dict<string | string[]> | string[]
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};

  if (Array.isArray(rawHeaders)) {
    // Array of key, value alternating pairs from req.rawHeaders
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i].toLowerCase();
      const val = rawHeaders[i + 1] ?? '';

      if (key === 'set-cookie') {
        const existing = normalized[key];
        if (Array.isArray(existing)) {
          existing.push(val);
        } else if (typeof existing === 'string') {
          normalized[key] = [existing, val];
        } else {
          normalized[key] = [val];
        }
      } else {
        const existing = normalized[key];
        if (typeof existing === 'string') {
          normalized[key] = `${existing}, ${val.trim()}`;
        } else {
          normalized[key] = val.trim();
        }
      }
    }
  } else {
    for (const [key, val] of Object.entries(rawHeaders)) {
      if (val === undefined) continue;
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'set-cookie') {
        if (Array.isArray(val)) {
          normalized[lowerKey] = [...val];
        } else {
          normalized[lowerKey] = [val];
        }
      } else if (Array.isArray(val)) {
        normalized[lowerKey] = val.map((v) => v.trim()).join(', ');
      } else {
        normalized[lowerKey] = val.trim();
      }
    }
  }

  return normalized;
}

/**
 * Prepares normalized headers for forwarding upstream:
 * - Removes hop-by-hop headers and any header listed in the Connection header
 * - Handles X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host
 * - Adds Via: 1.1 cdn-proxy
 * - Sets Host header (originHost by default, or client host if preserveHost=true)
 */
export function normalizeHeadersForForwarding(
  incomingHeaders: Record<string, string | string[]>,
  options: HeaderNormalizationOptions = {}
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const trustForwarded = options.trustForwardedHeaders ?? false;
  const preserveHost = options.preserveHost ?? false;
  const proxyVia = options.proxyVia ?? '1.1 cdn-proxy';

  // Find any headers listed in the "Connection" header
  const customHopByHop = new Set<string>();
  const connVal = incomingHeaders['connection'];
  if (typeof connVal === 'string') {
    for (const part of connVal.split(',')) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        customHopByHop.add(trimmed);
      }
    }
  } else if (Array.isArray(connVal)) {
    for (const item of connVal) {
      for (const part of item.split(',')) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) customHopByHop.add(trimmed);
      }
    }
  }

  // Copy non-hop-by-hop headers
  for (const [key, val] of Object.entries(incomingHeaders)) {
    const lowerKey = key.toLowerCase();

    // Check if hop-by-hop (standard or named in Connection header)
    if (STANDARD_HOP_BY_HOP.has(lowerKey) || customHopByHop.has(lowerKey)) {
      continue;
    }

    // Check client-supplied internal headers spoofing protection
    if (!trustForwarded && isInternalHeader(lowerKey)) {
      continue;
    }

    result[lowerKey] = val;
  }

  // Host header handling
  const clientHost = incomingHeaders['host'];
  if (preserveHost && typeof clientHost === 'string') {
    result['host'] = clientHost;
  } else if (options.originHost) {
    result['host'] = options.originHost;
  }

  // Forwarded headers handling
  const clientIp = options.clientIp;
  if (clientIp) {
    const existingXff = trustForwarded ? incomingHeaders['x-forwarded-for'] : undefined;
    if (typeof existingXff === 'string' && existingXff.trim()) {
      result['x-forwarded-for'] = `${existingXff.trim()}, ${clientIp}`;
    } else {
      result['x-forwarded-for'] = clientIp;
    }
  }

  const proto = options.isTls ? 'https' : 'http';
  if (trustForwarded && typeof incomingHeaders['x-forwarded-proto'] === 'string') {
    result['x-forwarded-proto'] = incomingHeaders['x-forwarded-proto'];
  } else {
    result['x-forwarded-proto'] = proto;
  }

  const effectiveHost = typeof clientHost === 'string' ? clientHost : options.originHost;
  if (trustForwarded && typeof incomingHeaders['x-forwarded-host'] === 'string') {
    result['x-forwarded-host'] = incomingHeaders['x-forwarded-host'];
  } else if (effectiveHost) {
    result['x-forwarded-host'] = effectiveHost;
  }

  // Via header
  const existingVia = incomingHeaders['via'];
  if (typeof existingVia === 'string' && existingVia.trim()) {
    result['via'] = `${existingVia.trim()}, ${proxyVia}`;
  } else {
    result['via'] = proxyVia;
  }

  // Apply proxy-injected internal headers (e.g. verified tenant, authenticated client identity)
  if (options.internalHeaders) {
    for (const [k, v] of Object.entries(options.internalHeaders)) {
      if (v !== undefined) {
        result[k.toLowerCase()] = v;
      }
    }
  }

  return result;
}
