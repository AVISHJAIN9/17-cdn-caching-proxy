import dns from 'node:dns';
import { isIpMatch, isIpInList } from './ip.js';

// Reserved, private, link-local, loopback, and metadata CIDR blocks
export const RESERVED_IP_RANGES = [
  // IPv4
  '0.0.0.0/8',          // Current network (RFC 1122)
  '10.0.0.0/8',         // Private network (RFC 1918)
  '100.64.0.0/10',      // Shared address space / CGNAT (RFC 6598)
  '127.0.0.0/8',        // Loopback (RFC 1122)
  '169.254.0.0/16',     // Link-local / Cloud metadata (AWS/GCP/Azure IMDS 169.254.169.254)
  '172.16.0.0/12',      // Private network (RFC 1918)
  '192.0.0.0/24',       // IETF Protocol Assignments
  '192.0.2.0/24',       // TEST-NET-1 (RFC 5737)
  '192.168.0.0/16',     // Private network (RFC 1918)
  '198.18.0.0/15',      // Network benchmark tests (RFC 2544)
  '198.51.100.0/24',    // TEST-NET-2 (RFC 5737)
  '203.0.113.0/24',     // TEST-NET-3 (RFC 5737)
  '224.0.0.0/4',        // Multicast
  '240.0.0.0/4',        // Reserved for future use
  '255.255.255.255/32', // Broadcast

  // IPv6
  '::/128',             // Unspecified
  '::1/128',            // Loopback
  'fc00::/7',           // Unique local address (ULA)
  'fe80::/10',          // Link-local unicast
  'ff00::/8',           // Multicast
] as const;

/**
 * Checks whether an IP belongs to private, loopback, link-local, or cloud-metadata ranges.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  return isIpInList(ip, RESERVED_IP_RANGES);
}

export interface OriginAccessConfig {
  blockPrivateOrigins?: boolean; // default true (SSRF protection)
  allowedPrivateOrigins?: readonly string[]; // explicitly allowlisted private origins (e.g. ['http://127.0.0.1:9090'])
  allowedOrigins?: readonly string[]; // global allowlist of origins
  tenantAllowedOrigins?: Record<string, readonly string[]>; // tenant -> allowed origins mapping
}

/**
 * Validates whether an origin URL is permitted before connecting:
 * - Checks against tenant allowlist (if tenant is resolved)
 * - Checks against global allowlist (if configured)
 * - Checks private IP blocking (unless explicitly allowlisted)
 */
export function isOriginAllowed(
  originUrlStr: string,
  config: OriginAccessConfig = {},
  tenantId?: string
): { allowed: boolean; reason?: 'SSRF_BLOCKED' | 'ORIGIN_NOT_ALLOWED'; message?: string } {
  let parsed: URL;
  try {
    parsed = new URL(originUrlStr);
  } catch {
    return { allowed: false, reason: 'ORIGIN_NOT_ALLOWED', message: 'Malformed origin URL' };
  }

  const normalizedOrigin = `${parsed.protocol}//${parsed.host}`;

  // 1. Tenant Origin Mapping Check
  if (tenantId && config.tenantAllowedOrigins?.[tenantId]) {
    const tenantAllowed = config.tenantAllowedOrigins[tenantId];
    const match = tenantAllowed.some((allowed) => {
      if (allowed === '*') return true;
      try {
        const allowedUrl = new URL(allowed);
        return `${allowedUrl.protocol}//${allowedUrl.host}` === normalizedOrigin;
      } catch {
        return allowed === normalizedOrigin;
      }
    });

    if (!match) {
      return {
        allowed: false,
        reason: 'ORIGIN_NOT_ALLOWED',
        message: `Tenant "${tenantId}" is not permitted to access origin "${normalizedOrigin}"`,
      };
    }
  }

  // 2. Global Origin Allowlist Check
  if (config.allowedOrigins && config.allowedOrigins.length > 0) {
    const match = config.allowedOrigins.some((allowed) => {
      if (allowed === '*') return true;
      try {
        const allowedUrl = new URL(allowed);
        return `${allowedUrl.protocol}//${allowedUrl.host}` === normalizedOrigin;
      } catch {
        return allowed === normalizedOrigin;
      }
    });

    if (!match) {
      return {
        allowed: false,
        reason: 'ORIGIN_NOT_ALLOWED',
        message: `Origin "${normalizedOrigin}" is not in global allowed origins list`,
      };
    }
  }

  // 3. Initial IP / Host SSRF check
  const blockPrivate = config.blockPrivateOrigins ?? true;
  if (blockPrivate) {
    const isExplicitlyAllowed = config.allowedPrivateOrigins?.some((allowed) => {
      try {
        const allowedUrl = new URL(allowed);
        return `${allowedUrl.protocol}//${allowedUrl.host}` === normalizedOrigin;
      } catch {
        return allowed === normalizedOrigin;
      }
    });

    if (!isExplicitlyAllowed && isPrivateOrReservedIp(parsed.hostname)) {
      return {
        allowed: false,
        reason: 'SSRF_BLOCKED',
        message: `SSRF defense: direct connection to private/reserved IP "${parsed.hostname}" is forbidden`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Creates a DNS lookup function that validates resolved IP addresses at connect time
 * to prevent DNS rebinding attacks.
 */
export function createSsrfProtectingLookup(
  config: OriginAccessConfig = {},
  customLookup?: any
): (hostname: string, options: any, callback: (err: any, address?: any, family?: any) => void) => void {
  const blockPrivate = config.blockPrivateOrigins ?? true;
  const baseLookup = customLookup ?? dns.lookup;

  return (hostname: string, options: any, callback: (err: any, address?: any, family?: any) => void) => {
    // Normalise options
    let opts = options;
    let cb = callback;
    if (typeof options === 'function') {
      cb = options;
      opts = {};
    }

    baseLookup(hostname, opts, (err: any, address: any, family: any) => {
      if (err) {
        cb(err);
        return;
      }

      if (!blockPrivate) {
        cb(null, address, family);
        return;
      }

      // Check each resolved address
      const addressesToCheck: string[] = Array.isArray(address)
        ? address.map((a: any) => (typeof a === 'string' ? a : a.address))
        : typeof address === 'string'
        ? [address]
        : [];

      for (const ip of addressesToCheck) {
        if (isPrivateOrReservedIp(ip)) {
          // Check if this hostname / ip is in explicitly allowed private origins
          const isExplicitlyAllowed = config.allowedPrivateOrigins?.some((allowed) => {
            try {
              const url = new URL(allowed);
              return url.hostname === hostname || url.hostname === ip;
            } catch {
              return allowed === hostname || allowed === ip;
            }
          });

          if (!isExplicitlyAllowed) {
            const ssrfError: any = new Error(
              `SSRF defense (DNS rebinding): Hostname "${hostname}" resolved to private/reserved IP "${ip}"`
            );
            ssrfError.code = 'SSRF_BLOCKED';
            cb(ssrfError);
            return;
          }
        }
      }

      cb(null, address, family);
    });
  };
}
