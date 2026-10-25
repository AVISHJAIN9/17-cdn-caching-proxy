import { z } from 'zod';
import { URL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { TimeoutConfig } from '../proxy/timeouts.js';
import { mapSystemError } from '../proxy/errors.js';

export interface OriginEntry {
  url: string;
  hostHeader?: string;
  timeouts?: Partial<TimeoutConfig>;
  maxSockets?: number;
  verifyTls?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  connectTimeoutMs?: number;
}

import type {
  OriginPoolConfig,
  OriginPoolMember,
} from './pools.js';
import {
  originPoolConfigSchema,
  originPoolMemberSchema,
  PoolSelector,
  defaultPoolSelector,
} from './pools.js';

export {
  OriginPoolConfig,
  OriginPoolMember,
  originPoolConfigSchema,
  originPoolMemberSchema,
  PoolSelector,
  defaultPoolSelector,
};

export interface OriginRouteRule {
  pathPrefix?: string;
  pathPattern?: string;
  host?: string;
  header?: { name: string; value: string };
  origin: string;
}

export interface OriginsConfig {
  origins: Record<string, OriginEntry>;
  defaultOrigin: string;
  routes?: OriginRouteRule[];
  pools?: Record<string, OriginPoolConfig>;
}

const HOST_HEADER_REGEX = /^([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?$/;

export const originEntrySchema = z
  .object({
    url: z.string().superRefine((val, ctx) => {
      const portMatch = val.match(/:([0-9]+)(?:\/|\?|#|$)/);
      if (portMatch) {
        const portNum = parseInt(portMatch[1], 10);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Port out of range (1-65535): ${portMatch[1]}`,
          });
          return;
        }
      }

      let parsed: URL;
      try {
        parsed = new URL(val);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid URL format: "${val}"`,
        });
        return;
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `URL protocol must be "http:" or "https:", received "${parsed.protocol}"`,
        });
      }

      if (parsed.username || parsed.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Origin URL must not contain credentials (user:pass@)',
        });
      }

      if (parsed.search) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Origin URL must not contain query strings',
        });
      }

      if (parsed.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Origin URL must not contain URL fragments (#)',
        });
      }

      if (parsed.port) {
        const portNum = parseInt(parsed.port, 10);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Port out of range (1-65535): ${parsed.port}`,
          });
        }
      }
    }),
    hostHeader: z
      .string()
      .optional()
      .superRefine((val, ctx) => {
        if (!val) return;
        if (!HOST_HEADER_REGEX.test(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `hostHeader must be a valid host[:port], received "${val}"`,
          });
          return;
        }
        const parts = val.split(':');
        if (parts.length === 2 && !val.startsWith('[')) {
          const portNum = parseInt(parts[1], 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `hostHeader port out of range (1-65535): ${parts[1]}`,
            });
          }
        }
      }),
    timeouts: z
      .object({
        upstreamConnectMs: z.number().int().nonnegative().optional(),
        upstreamHeadersMs: z.number().int().nonnegative().optional(),
        upstreamIdleMs: z.number().int().nonnegative().optional(),
        clientHeadersMs: z.number().int().nonnegative().optional(),
        clientRequestMs: z.number().int().nonnegative().optional(),
        keepAliveTimeoutMs: z.number().int().nonnegative().optional(),
        totalRequestMs: z.number().int().nonnegative().optional(),
      })
      .optional(),
    maxSockets: z.number().int().positive().optional(),
    verifyTls: z.boolean().optional(),
    ca: z.any().optional(),
    connectTimeoutMs: z.number().int().nonnegative().optional(),
  });

export const originRouteRuleSchema = z.object({
  pathPrefix: z.string().optional(),
  pathPattern: z.string().optional(),
  host: z.string().optional(),
  header: z.object({ name: z.string(), value: z.string() }).optional(),
  origin: z.string(),
});

export const originsConfigSchema = z
  .object({
    origins: z.record(z.string(), originEntrySchema),
    defaultOrigin: z.string(),
    routes: z.array(originRouteRuleSchema).optional(),
    pools: z.record(z.string(), originPoolConfigSchema).optional(),
  })
  .superRefine((val, ctx) => {
    const keys = Object.keys(val.origins);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['origins'],
        message: 'At least one origin must be configured in origins map',
      });
      return;
    }

    for (const key of keys) {
      if (!key.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['origins', key],
          message: 'Origin ID must not be empty or whitespace',
        });
      }
    }

    if (!val.defaultOrigin || !val.defaultOrigin.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultOrigin'],
        message: 'defaultOrigin must not be empty',
      });
    } else if (!val.origins[val.defaultOrigin] && (!val.pools || !val.pools[val.defaultOrigin])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultOrigin'],
        message: `defaultOrigin "${val.defaultOrigin}" does not exist in configured origins [${keys.join(', ')}] or pools`,
      });
    }

    if (val.pools) {
      for (const [poolId, pool] of Object.entries(val.pools)) {
        for (const member of pool.members) {
          if (!val.origins[member.origin]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['pools', poolId, 'members'],
              message: `Pool member origin "${member.origin}" does not exist in configured origins [${keys.join(', ')}]`,
            });
          }
        }
      }
    }
  });

/**
 * Normalizes and validates configuration input, supporting:
 * - Full { origins: { ... }, defaultOrigin: "..." }
 * - Legacy Batch 1 single { origin: { url: "..." } } mapped to origin "default"
 * - Environment variable override (ORIGIN_URL sets/replaces default origin)
 */
export function parseOriginsConfig(
  rawInput?: any,
  env: NodeJS.ProcessEnv = process.env
): OriginsConfig {
  let normalized: any = rawInput ? { ...rawInput } : {};

  // Support Batch 1 legacy config: { origin: { url: "..." } }
  if (normalized.origin && typeof normalized.origin === 'object' && normalized.origin.url) {
    if (!normalized.origins) {
      normalized.origins = {
        default: {
          url: normalized.origin.url,
          hostHeader: normalized.origin.hostHeader,
        },
      };
      normalized.defaultOrigin = 'default';
    }
  }

  // If no origins configured yet, provide empty skeleton
  if (!normalized.origins) {
    normalized.origins = {};
  }
  if (!normalized.defaultOrigin && Object.keys(normalized.origins).length > 0) {
    normalized.defaultOrigin = Object.keys(normalized.origins)[0];
  } else if (!normalized.defaultOrigin) {
    normalized.defaultOrigin = 'default';
  }

  // Env override precedence: ORIGIN_URL overrides the default origin URL
  if (env.ORIGIN_URL && env.ORIGIN_URL.trim()) {
    const defId = normalized.defaultOrigin || 'default';
    normalized.defaultOrigin = defId;
    normalized.origins[defId] = {
      ...(normalized.origins[defId] ?? { verifyTls: true }),
      url: env.ORIGIN_URL.trim(),
    };
  }

  // If still empty origins, create default from localhost:9090 fallback
  if (Object.keys(normalized.origins).length === 0) {
    normalized.origins = {
      default: {
        url: 'http://127.0.0.1:9090',
        verifyTls: true,
      },
    };
    normalized.defaultOrigin = 'default';
  }

  const result = originsConfigSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues ?? (result.error as any).errors ?? [];
    const errorMessages = issues.map((e: any) => {
      const pathStr = e.path.length > 0 ? e.path.join('.') : 'root';
      return `Config validation error at [${pathStr}]: ${e.message}`;
    });
    const err = new Error(errorMessages.join('\n'));
    (err as any).issues = issues;
    throw err;
  }

  return result.data as OriginsConfig;
}

/**
 * Prepend an origin's base path to a forwarded request path without double slashes.
 * e.g.
 * joinBasePath("https://api.example.com/v1", "/users") -> "/v1/users"
 * joinBasePath("https://api.example.com/v1/", "/users") -> "/v1/users"
 * joinBasePath("https://api.example.com", "/users") -> "/users"
 * joinBasePath("https://api.example.com/", "/users") -> "/users"
 * joinBasePath("https://api.example.com/v1", "") -> "/v1"
 */
export function joinBasePath(originUrl: string, requestPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    return requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  }

  let basePath = parsed.pathname;
  if (basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }

  let subPath = requestPath.trim();
  if (subPath.startsWith('/')) {
    subPath = subPath.slice(1);
  }

  if (!basePath && !subPath) {
    return '/';
  }
  if (!basePath) {
    return `/${subPath}`;
  }
  if (!subPath) {
    return basePath.startsWith('/') ? basePath : `/${basePath}`;
  }

  return `${basePath}/${subPath}`;
}

/**
 * Redacts secrets / credentials for safe printing.
 */
export function redactConfig(config: OriginsConfig): OriginsConfig {
  const redacted: OriginsConfig = JSON.parse(JSON.stringify(config));
  for (const [id, entry] of Object.entries(redacted.origins)) {
    try {
      const u = new URL(entry.url);
      if (u.password) u.password = '******';
      redacted.origins[id].url = u.toString();
    } catch {
      // ignore
    }
  }
  return redacted;
}

/**
 * Validates an origin entry schema.
 */
export function validateOriginConfig(entry: unknown): { valid: boolean; errors: string[] } {
  const result = originEntrySchema.safeParse(entry);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  const issues = result.error.issues ?? [];
  return {
    valid: false,
    errors: issues.map((i) => i.message),
  };
}

/**
 * Actively probes origin reachability via HTTP/HTTPS.
 */
export async function validateOriginReachability(
  origin: OriginEntry,
  timeoutMs = 5000
): Promise<{ reachable: boolean; statusCode?: number; error?: string }> {
  try {
    const parsed = new URL(origin.url);
    const isHttps = parsed.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const agent = isHttps
      ? new https.Agent({
          rejectUnauthorized: origin.verifyTls ?? true,
          ca: origin.ca,
        })
      : undefined;

    return await new Promise<{ reachable: boolean; statusCode?: number; error?: string }>((resolve) => {
      let settled = false;
      const req = requestFn(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname || '/',
          method: 'GET',
          agent,
          timeout: timeoutMs,
          headers: {
            Host: origin.hostHeader || parsed.host,
            'User-Agent': 'cdn-proxy-health-check/1.0',
          },
        },
        (res) => {
          if (!settled) {
            settled = true;
            res.resume();
            res.on('end', () => {
              if (agent) agent.destroy();
            });
            resolve({ reachable: true, statusCode: res.statusCode });
          }
        }
      );

      const finishError = (err: any) => {
        if (!settled) {
          settled = true;
          req.destroy();
          if (agent) agent.destroy();
          const mapped = mapSystemError(err);
          resolve({ reachable: false, error: mapped.code });
        }
      };

      req.on('timeout', () => {
        finishError({ code: 'ETIMEDOUT', message: 'Reachability probe timed out' });
      });

      req.on('error', (err) => {
        finishError(err);
      });

      req.end();
    });
  } catch (err: any) {
    const mapped = mapSystemError(err);
    return { reachable: false, error: mapped.code };
  }
}

/**
 * Matches an incoming request to its configured route target (origin or pool ID).
 */
export function matchOriginRoute(
  req: { url: string; headers?: Record<string, string | string[] | undefined> },
  config: OriginsConfig
): string {
  const routes = config.routes ?? [];
  const reqUrl = req.url || '/';
  const pathname = reqUrl.split('?')[0] || '/';
  const headers = req.headers || {};
  const hostHeader = typeof headers['host'] === 'string' ? headers['host'] : '';
  const hostWithoutPort = hostHeader.split(':')[0] || '';

  let target = config.defaultOrigin;

  for (const rule of routes) {
    if (rule.host) {
      const ruleHost = rule.host.toLowerCase();
      if (hostHeader.toLowerCase() !== ruleHost && hostWithoutPort.toLowerCase() !== ruleHost) {
        continue;
      }
    }

    if (rule.header) {
      const headerName = rule.header.name.toLowerCase();
      const actualVal = headers[headerName];
      if (typeof actualVal !== 'string' || actualVal.toLowerCase() !== rule.header.value.toLowerCase()) {
        continue;
      }
    }

    if (rule.pathPrefix) {
      if (!pathname.startsWith(rule.pathPrefix)) {
        continue;
      }
    }

    if (rule.pathPattern) {
      try {
        const regex = new RegExp(rule.pathPattern);
        if (!regex.test(pathname)) {
          continue;
        }
      } catch {
        continue;
      }
    }

    target = rule.origin;
    break;
  }

  return target;
}

/**
 * Resolves the destination origin ID for an incoming request based on configured routes and pools.
 */
export function resolveOriginForRequest(
  req: { url: string; headers?: Record<string, string | string[] | undefined> },
  config: OriginsConfig,
  poolSelector: PoolSelector = defaultPoolSelector
): string {
  const target = matchOriginRoute(req, config);

  // If target matches an origin pool, select an available member from the pool
  if (config.pools && config.pools[target]) {
    const selected = poolSelector.selectMember(target, config.pools[target]);
    if (selected) {
      return selected;
    }
  }

  return target;
}


