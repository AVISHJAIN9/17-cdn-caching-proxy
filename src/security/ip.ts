/**
 * IP Access Control and Resolution Module (Features 86 & 87)
 * - IPv4 & IPv6 CIDR matching (/0 to /32 for IPv4, /0 to /128 for IPv6)
 * - IPv4-mapped IPv6 normalization (::ffff:x.x.x.x)
 * - Right-to-left X-Forwarded-For traversal with trusted proxy validation
 * - Denylist precedence over allowlist
 */

export function parseIpv4(ip: string): bigint | null {
  const trimmed = ip.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;

  let res = 0n;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!part || !/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    res = (res << 8n) | BigInt(num);
  }
  return res;
}

export function isIpv4MappedIpv6(ip: string): boolean {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith('::ffff:') && lower.indexOf('.', 7) !== -1;
}

export function extractIpv4FromMapped(ip: string): string {
  const lower = ip.trim().toLowerCase();
  if (lower.startsWith('::ffff:')) {
    return lower.slice(7);
  }
  return ip.trim();
}

export function parseIpv6(ip: string): bigint | null {
  let str = ip.trim().toLowerCase();
  if (!str) return null;

  // Handle embedded IPv4 (e.g. ::ffff:192.168.1.1)
  if (isIpv4MappedIpv6(str)) {
    const v4 = parseIpv4(str.slice(7));
    if (v4 === null) return null;
    return (0xffffn << 32n) | v4;
  }

  const doubleColonIndex = str.indexOf('::');
  let leftGroups: string[] = [];
  let rightGroups: string[] = [];

  if (doubleColonIndex !== -1) {
    // Only one '::' allowed
    if (str.indexOf('::', doubleColonIndex + 2) !== -1) {
      return null;
    }
    const leftPart = str.slice(0, doubleColonIndex);
    const rightPart = str.slice(doubleColonIndex + 2);
    if (leftPart) leftGroups = leftPart.split(':');
    if (rightPart) rightGroups = rightPart.split(':');
  } else {
    leftGroups = str.split(':');
  }

  const totalSpecified = leftGroups.length + rightGroups.length;
  if (totalSpecified > 8) return null;
  if (doubleColonIndex === -1 && totalSpecified !== 8) return null;

  const missingZeros = 8 - totalSpecified;
  const groups = [...leftGroups, ...Array(missingZeros).fill('0'), ...rightGroups];

  let res = 0n;
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (!group || !/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const val = parseInt(group, 16);
    res = (res << 16n) | BigInt(val);
  }
  return res;
}

/**
 * Checks whether an IP matches a single pattern (exact IP or CIDR notation).
 */
export function isIpMatch(targetIp: string, pattern: string): boolean {
  const rawTarget = targetIp.trim();
  const rawPattern = pattern.trim();
  if (!rawTarget || !rawPattern) return false;

  // Exact string match check first
  if (rawTarget.toLowerCase() === rawPattern.toLowerCase()) return true;

  // Handle CIDR
  const [networkStr, prefixStr] = rawPattern.split('/');
  const isCidr = prefixStr !== undefined;

  // Check IPv4
  const targetV4 = isIpv4MappedIpv6(rawTarget)
    ? parseIpv4(extractIpv4FromMapped(rawTarget))
    : parseIpv4(rawTarget);

  if (targetV4 !== null) {
    // Target is IPv4 (or IPv4-mapped)
    // Check if pattern is also IPv4 or IPv4-mapped
    const patternIsMapped = isIpv4MappedIpv6(networkStr);
    const patternV4 = patternIsMapped
      ? parseIpv4(extractIpv4FromMapped(networkStr))
      : parseIpv4(networkStr);

    if (patternV4 !== null) {
      let prefix = 32;
      if (isCidr) {
        prefix = parseInt(prefixStr, 10);
        if (patternIsMapped && prefix >= 96) {
          // e.g. ::ffff:192.168.0.0/112 -> IPv4 /16
          prefix = prefix - 96;
        }
        if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
      }
      const mask = prefix === 0 ? 0n : ((0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn);
      return (targetV4 & mask) === (patternV4 & mask);
    }
  }

  // Check IPv6
  const targetV6 = parseIpv6(rawTarget);
  const patternV6 = parseIpv6(networkStr);

  if (targetV6 !== null && patternV6 !== null) {
    let prefix = 128;
    if (isCidr) {
      prefix = parseInt(prefixStr, 10);
      if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
    }
    const mask = prefix === 0 ? 0n : ((~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n));
    return (targetV6 & mask) === (patternV6 & mask);
  }

  return false;
}

export function isIpInList(targetIp: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (isIpMatch(targetIp, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the authenticated client IP by walking X-Forwarded-For right-to-left
 * against configured trusted proxies.
 */
export function resolveClientIp(
  remoteAddress: string,
  xForwardedForHeader?: string | string[] | undefined,
  trustedProxies?: readonly string[]
): string {
  const directPeer = remoteAddress.trim();
  if (!trustedProxies || trustedProxies.length === 0) {
    return directPeer;
  }

  // If the direct connecting socket is not a trusted proxy, ignore XFF completely
  if (!isIpInList(directPeer, trustedProxies)) {
    return directPeer;
  }

  if (!xForwardedForHeader) {
    return directPeer;
  }

  // Parse comma-separated X-Forwarded-For IPs
  const xffStr = Array.isArray(xForwardedForHeader)
    ? xForwardedForHeader.join(',')
    : xForwardedForHeader;

  const rawIps = xffStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawIps.length === 0) {
    return directPeer;
  }

  // Walk right-to-left
  // Starting from the rightmost proxy in XFF
  for (let i = rawIps.length - 1; i >= 0; i--) {
    const candidateIp = rawIps[i];
    // If this IP is NOT trusted, it is the first untrusted hop -> real client!
    if (!isIpInList(candidateIp, trustedProxies)) {
      return candidateIp;
    }
  }

  // If all IPs in X-Forwarded-For were trusted proxies, the client is the leftmost IP
  return rawIps[0];
}

export interface IpFilterConfig {
  allowlist?: readonly string[];
  denylist?: readonly string[];
  trustedProxies?: readonly string[];
}

export interface IpFilterResult {
  allowed: boolean;
  clientIp: string;
  reason?: 'IP_DENIED' | 'IP_NOT_ALLOWED';
}

/**
 * Validates client IP against denylist and allowlist.
 * Denylist takes absolute precedence over allowlist.
 */
export function evaluateIpAccess(
  remoteAddress: string,
  xForwardedForHeader?: string | string[] | undefined,
  config: IpFilterConfig = {}
): IpFilterResult {
  const clientIp = resolveClientIp(remoteAddress, xForwardedForHeader, config.trustedProxies);

  // 1. Denylist check (highest precedence)
  if (config.denylist && config.denylist.length > 0) {
    if (isIpInList(clientIp, config.denylist)) {
      return { allowed: false, clientIp, reason: 'IP_DENIED' };
    }
  }

  // 2. Allowlist check (if non-empty, must match)
  if (config.allowlist && config.allowlist.length > 0) {
    if (!isIpInList(clientIp, config.allowlist)) {
      return { allowed: false, clientIp, reason: 'IP_NOT_ALLOWED' };
    }
  }

  return { allowed: true, clientIp };
}
