import { isCompressibleContentType, ContentTypeRulesConfig } from './rules.js';

export interface CompressionBypassConfig {
  header?: string;
  routes?: (string | RegExp)[];
}

export type CompressionBypassReason =
  | 'below_min_size'
  | 'no_transform'
  | 'already_encoded'
  | 'non_compressible_type'
  | 'range_request'
  | 'status_no_body'
  | 'head_method'
  | 'configured_bypass';

export interface CompressionBypassCheckInput {
  method?: string;
  statusCode?: number;
  requestHeaders?: Record<string, string | string[] | undefined>;
  responseHeaders?: Record<string, string | string[] | undefined>;
  bodyLength?: number;
  url?: string;
  minBytes?: number;
  typesConfig?: ContentTypeRulesConfig;
  bypassConfig?: CompressionBypassConfig;
}

export interface CompressionBypassResult {
  shouldBypass: boolean;
  reason?: CompressionBypassReason;
}

/**
 * Checks all compression bypass rules in strict priority order.
 * Returns { shouldBypass: true, reason } if compression should be skipped.
 */
export function checkCompressionBypass(
  input: CompressionBypassCheckInput
): CompressionBypassResult {
  const method = input.method?.toUpperCase();

  // 1. HEAD request - never stream compressed body
  if (method === 'HEAD') {
    return { shouldBypass: true, reason: 'head_method' };
  }

  // 2. HTTP 204 (No Content) or 304 (Not Modified)
  if (input.statusCode === 204 || input.statusCode === 304) {
    return { shouldBypass: true, reason: 'status_no_body' };
  }

  // 3. Range requests or 206 Partial Content
  if (
    input.statusCode === 206 ||
    input.requestHeaders?.['range'] !== undefined ||
    input.responseHeaders?.['content-range'] !== undefined
  ) {
    return { shouldBypass: true, reason: 'range_request' };
  }

  // 4. Configured bypass header or route
  if (input.bypassConfig?.header) {
    const customHeader = input.bypassConfig.header.toLowerCase();
    if (input.requestHeaders?.[customHeader] !== undefined) {
      return { shouldBypass: true, reason: 'configured_bypass' };
    }
  } else if (input.requestHeaders?.['x-no-compression'] !== undefined) {
    return { shouldBypass: true, reason: 'configured_bypass' };
  }

  if (input.url && input.bypassConfig?.routes) {
    for (const route of input.bypassConfig.routes) {
      if (typeof route === 'string' ? input.url.startsWith(route) : route.test(input.url)) {
        return { shouldBypass: true, reason: 'configured_bypass' };
      }
    }
  }

  // 5. Cache-Control: no-transform
  const reqCc = input.requestHeaders?.['cache-control'];
  const resCc = input.responseHeaders?.['cache-control'];
  const allCc = [reqCc, resCc]
    .flat()
    .filter(Boolean)
    .join(', ')
    .toLowerCase();
  if (allCc.includes('no-transform')) {
    return { shouldBypass: true, reason: 'no_transform' };
  }

  // 6. Already encoded origin response
  const ce = input.responseHeaders?.['content-encoding'];
  if (
    ce &&
    typeof ce === 'string' &&
    ce.trim().length > 0 &&
    ce.trim().toLowerCase() !== 'identity'
  ) {
    return { shouldBypass: true, reason: 'already_encoded' };
  }

  // 7. Non-compressible content type
  const ct = input.responseHeaders?.['content-type'];
  const rawCt = Array.isArray(ct) ? ct[0] : ct;
  if (!isCompressibleContentType(rawCt, input.typesConfig)) {
    return { shouldBypass: true, reason: 'non_compressible_type' };
  }

  // 8. Size threshold: below minimum size
  const minBytes = input.minBytes ?? 1024;
  let len = input.bodyLength;
  if (len === undefined && input.responseHeaders?.['content-length'] !== undefined) {
    const rawCl = input.responseHeaders['content-length'];
    const parsedCl = parseInt(Array.isArray(rawCl) ? rawCl[0] : String(rawCl), 10);
    if (!isNaN(parsedCl)) len = parsedCl;
  }

  if (len !== undefined && len < minBytes) {
    return { shouldBypass: true, reason: 'below_min_size' };
  }

  return { shouldBypass: false };
}
