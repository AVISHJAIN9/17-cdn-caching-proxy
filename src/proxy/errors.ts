/**
 * Standard ProxyError and system error taxonomy for the CDN Caching Proxy.
 */

export class ProxyError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly publicMessage: string;
  public readonly retryable: boolean;
  public readonly cause?: any;
  public readonly allowHeader?: string;

  constructor(
    code: string,
    status: number,
    publicMessage: string,
    options?: { cause?: any; retryable?: boolean; allowHeader?: string }
  ) {
    super(publicMessage);
    this.name = 'ProxyError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
    this.allowHeader = options?.allowHeader;
  }
}

export interface SystemErrorMapping {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
}

/**
 * Table-driven mapping from Node.js / system error codes to ProxyError definitions.
 */
export const SYSTEM_ERROR_TABLE: Record<string, SystemErrorMapping> = {
  ECONNREFUSED: {
    code: 'UPSTREAM_CONNECT_FAILED',
    status: 502,
    message: 'Failed to connect to upstream origin server',
    retryable: false,
  },
  ENOTFOUND: {
    code: 'UPSTREAM_DNS_FAILED',
    status: 502,
    message: 'DNS resolution failed for upstream origin server',
    retryable: false,
  },
  EAI_AGAIN: {
    code: 'UPSTREAM_DNS_FAILED',
    status: 502,
    message: 'Temporary DNS resolution failure for upstream origin server',
    retryable: true,
  },
  ECONNRESET: {
    code: 'UPSTREAM_CONNECTION_RESET',
    status: 502,
    message: 'Connection reset by upstream origin server',
    retryable: true,
  },
  EPIPE: {
    code: 'UPSTREAM_CONNECTION_RESET',
    status: 502,
    message: 'Broken pipe communicating with upstream origin server',
    retryable: true,
  },
  ETIMEDOUT: {
    code: 'UPSTREAM_CONNECT_TIMEOUT',
    status: 504,
    message: 'Connection timed out communicating with upstream origin server',
    retryable: false,
  },
  CERT_HAS_EXPIRED: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Upstream TLS certificate has expired',
    retryable: false,
  },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Self-signed certificate presented by upstream origin server',
    retryable: false,
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Unable to verify upstream TLS certificate signature',
    retryable: false,
  },
  ERR_TLS_CERT_ALTNAME_INVALID: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Upstream TLS certificate hostname does not match origin',
    retryable: false,
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Self-signed certificate in chain presented by upstream origin server',
    retryable: false,
  },
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: {
    code: 'UPSTREAM_TLS_ERROR',
    status: 502,
    message: 'Unable to get local issuer certificate for upstream origin server',
    retryable: false,
  },
  SSRF_BLOCKED: {
    code: 'SSRF_BLOCKED',
    status: 502,
    message: 'Upstream origin resolved to a prohibited private or reserved network address',
    retryable: false,
  },
};

/**
 * Maps any Node / system error to a safe ProxyError.
 */
export function mapSystemError(err: any): ProxyError {
  if (err instanceof ProxyError) {
    return err;
  }

  const rawCode = err?.code ?? '';
  const rawMsg = err?.message ?? '';

  // Check exact table entry by code
  if (rawCode && SYSTEM_ERROR_TABLE[rawCode]) {
    const entry = SYSTEM_ERROR_TABLE[rawCode];
    return new ProxyError(entry.code, entry.status, entry.message, {
      cause: err,
      retryable: entry.retryable,
    });
  }

  // Check TLS errors by message or code
  for (const [key, entry] of Object.entries(SYSTEM_ERROR_TABLE)) {
    if (
      key.startsWith('CERT_') ||
      key.startsWith('DEPTH_') ||
      key.startsWith('UNABLE_') ||
      key.startsWith('SELF_SIGNED_') ||
      key.startsWith('ERR_TLS_')
    ) {
      if (rawMsg.includes(key) || rawCode.includes(key)) {
        return new ProxyError(entry.code, entry.status, entry.message, {
          cause: err,
          retryable: entry.retryable,
        });
      }
    }
  }

  // Catch generic TLS/SSL handshake/certificate errors
  if (/tls|ssl|handshake|certificate|altname|untrusted/i.test(rawMsg)) {
    return new ProxyError(
      'UPSTREAM_TLS_ERROR',
      502,
      `Upstream TLS negotiation failed: ${rawMsg}`,
      { cause: err, retryable: false }
    );
  }

  // Check timeout errors by message
  if (/timeout/i.test(rawMsg)) {
    if (/connect timeout/i.test(rawMsg)) {
      return new ProxyError(
        'UPSTREAM_CONNECT_TIMEOUT',
        504,
        'Connection to upstream timed out',
        { cause: err, retryable: false }
      );
    }
    if (/headers timeout/i.test(rawMsg)) {
      return new ProxyError(
        'UPSTREAM_HEADERS_TIMEOUT',
        504,
        'Upstream headers timed out',
        { cause: err, retryable: false }
      );
    }
    return new ProxyError(
      'TOTAL_REQUEST_TIMEOUT',
      504,
      'Request exceeded timeout deadline',
      { cause: err, retryable: false }
    );
  }

  // Check Node HTTP parser errors
  if (rawCode.startsWith('HPE_') || /parse|content-length|header|invalid/i.test(rawMsg)) {
    return new ProxyError(
      'UPSTREAM_INVALID_RESPONSE',
      502,
      'Invalid HTTP response from upstream origin server',
      { cause: err, retryable: false }
    );
  }

  // Check generic socket hang up
  if (/socket hang up/i.test(rawMsg)) {
    return new ProxyError(
      'UPSTREAM_CONNECTION_RESET',
      502,
      'Connection reset by upstream origin server',
      { cause: err, retryable: true }
    );
  }

  // Fallback to internal error
  return new ProxyError(
    'INTERNAL_ERROR',
    500,
    'Internal server error processing request',
    { cause: err, retryable: false }
  );
}
