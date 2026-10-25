import {
  parseAcceptEncoding,
  getEncodingWeight,
} from './accept-encoding.js';

export interface NegotiationResult {
  encoding: string;
  q: number;
  acceptable: boolean;
}

/**
 * Selects the optimal encoding according to client preferences and proxy configuration.
 * Adheres to RFC 9110 Content Negotiation semantics.
 */
export function negotiateEncoding(
  acceptEncodingHeader: string | null | undefined,
  supported: string[] = ['zstd', 'br', 'gzip'],
  proxyPreference: string[] = ['zstd', 'br', 'gzip']
): NegotiationResult {
  // If header is absent or empty, identity is the default choice
  if (!acceptEncodingHeader || acceptEncodingHeader.trim().length === 0) {
    return {
      encoding: 'identity',
      q: 1.0,
      acceptable: true,
    };
  }

  const preferences = parseAcceptEncoding(acceptEncodingHeader);
  const identityWeight = getEncodingWeight(preferences, 'identity');

  // Candidate encodings supported by proxy with q > 0
  const candidateScores: Array<{ encoding: string; q: number; prefIndex: number }> = [];

  for (const enc of supported) {
    const q = getEncodingWeight(preferences, enc);
    if (q > 0) {
      const prefIndex = proxyPreference.indexOf(enc);
      candidateScores.push({
        encoding: enc,
        q,
        prefIndex: prefIndex >= 0 ? prefIndex : 999,
      });
    }
  }

  // If no supported non-identity encoding is acceptable
  if (candidateScores.length === 0) {
    if (identityWeight > 0) {
      return {
        encoding: 'identity',
        q: identityWeight,
        acceptable: true,
      };
    }
    // Client explicitly refused identity (e.g. identity;q=0 or *;q=0) and no supported coding matched
    return {
      encoding: 'identity',
      q: 0,
      acceptable: false,
    };
  }

  // Sort candidates:
  // 1. Highest q value first
  // 2. On tie, lowest prefIndex (proxy preference order)
  candidateScores.sort((a, b) => {
    if (b.q !== a.q) {
      return b.q - a.q;
    }
    return a.prefIndex - b.prefIndex;
  });

  const best = candidateScores[0];

  // If identity has a strictly higher q-value than all supported candidates, identity wins
  if (identityWeight > best.q) {
    return {
      encoding: 'identity',
      q: identityWeight,
      acceptable: true,
    };
  }

  return {
    encoding: best.encoding,
    q: best.q,
    acceptable: true,
  };
}

/**
 * Ensures the Vary header includes Accept-Encoding on cacheable or negotiated responses.
 */
export function ensureVaryAcceptEncoding(headers: Record<string, string | string[] | undefined>): void {
  const existingVary = headers['vary'] ?? headers['Vary'];
  if (!existingVary) {
    headers['vary'] = 'Accept-Encoding';
    return;
  }

  const varyStr = Array.isArray(existingVary) ? existingVary.join(', ') : String(existingVary);
  const parts = varyStr.split(',').map((p) => p.trim());
  if (!parts.some((p) => p.toLowerCase() === 'accept-encoding')) {
    parts.push('Accept-Encoding');
    headers['vary'] = parts.join(', ');
  }
}
