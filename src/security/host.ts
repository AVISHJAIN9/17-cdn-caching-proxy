import { domainToASCII } from 'node:url';

/**
 * Normalizes an HTTP Host value:
 * - Trims whitespace and converts to lowercase
 * - Strips default ports (:80, :443), while preserving non-default ports
 * - Handles IPv6 literals e.g. [::1]:80 -> [::1]
 * - Strips trailing dots (DNS FQDN representation, e.g. "example.com." -> "example.com")
 * - Normalizes internationalized domain names (IDN/Punycode) via domainToASCII
 */
export function normalizeHost(rawHost: string): string {
  let host = (rawHost || '').trim().toLowerCase();
  if (!host) return '';

  // Handle IPv6 address literal e.g. [::1]:80 or [::1]
  if (host.startsWith('[')) {
    const closingBracketIndex = host.indexOf(']');
    if (closingBracketIndex !== -1) {
      const ipv6Address = host.slice(0, closingBracketIndex + 1);
      const remainder = host.slice(closingBracketIndex + 1);
      if (remainder === ':80' || remainder === ':443') {
        return ipv6Address;
      }
      return host;
    }
  }

  // Port stripping for :80 and :443
  if (host.endsWith(':80')) {
    host = host.slice(0, -3);
  } else if (host.endsWith(':443')) {
    host = host.slice(0, -4);
  }

  // Trailing-dot normalization (e.g. "example.com." -> "example.com")
  while (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  // Punycode / IDN normalization via domainToASCII
  // If host contains a non-default port e.g. "example.com:8080", separate hostname and port
  const colonIndex = host.lastIndexOf(':');
  if (colonIndex !== -1) {
    const hostname = host.slice(0, colonIndex);
    const port = host.slice(colonIndex);
    const asciiHost = domainToASCII(hostname);
    return (asciiHost || hostname) + port;
  }

  const asciiHost = domainToASCII(host);
  return asciiHost || host;
}

/**
 * Checks if a normalized host is permitted by an allowlist.
 * Supports exact host match, wildcard '*', and wildcard subdomains '*.domain.com'.
 */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) {
    return true;
  }

  const normalizedTarget = normalizeHost(host);
  if (!normalizedTarget) {
    return false;
  }

  // Separate hostname from non-default port if present for wildcard domain checks
  const colonIndex = normalizedTarget.lastIndexOf(':');
  const targetDomain = colonIndex !== -1 ? normalizedTarget.slice(0, colonIndex) : normalizedTarget;

  for (const pattern of allowedHosts) {
    if (pattern === '*') {
      return true;
    }

    const normalizedPattern = normalizeHost(pattern);

    // Exact match (including port if specified in pattern)
    if (normalizedTarget === normalizedPattern) {
      return true;
    }

    // Exact match ignoring port if pattern has no port
    if (colonIndex !== -1 && targetDomain === normalizedPattern) {
      return true;
    }

    // Wildcard subdomain matching e.g. *.example.com
    if (pattern.startsWith('*.')) {
      const baseDomain = normalizeHost(pattern.slice(2));
      if (targetDomain.endsWith('.' + baseDomain) || targetDomain === baseDomain) {
        return true;
      }
    }
  }

  return false;
}
