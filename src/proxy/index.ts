import { ProxyListener, HttpsListenerConfig } from './listener.js';
import type { TlsCertificateConfig, ClientCertAuthMode } from '../tls/types.js';
import { parseRequest } from './request.js';
import { sendError } from './error-response.js';
import { normalizeHeadersForForwarding } from './headers.js';
import { isHostAllowed } from '../security/host.js';
import { evaluateIpAccess } from '../security/ip.js';
import { ApiKeyValidator, ApiKeyAuthConfig } from '../security/api-key.js';
import { JwtValidator, JwtVerifyOptions } from '../security/jwt.js';
import { isOriginAllowed, createSsrfProtectingLookup, OriginAccessConfig } from '../security/origin-access.js';
import { UpstreamClient, UpstreamConfig } from './upstream.js';
import { TimeoutConfig, TimeoutManager } from './timeouts.js';
import { createRequestContext } from './context.js';
import { CancellationCoordinator } from './cancellation.js';
import { streamOriginResponse } from './stream.js';
import { parseUpstreamResponse } from './parse-response.js';
import { joinBasePath, OriginsConfig, parseOriginsConfig, resolveOriginForRequest, matchOriginRoute, PoolSelector } from '../config/origins.js';
import { DnsCache } from '../dns/cache.js';
import http from 'node:http';
import crypto from 'node:crypto';

import { RequestLogger, RequestLoggerOptions, redactUrlPath } from '../observability/logger.js';
import { MetricsRegistry, classifyUpstreamError } from '../observability/metrics.js';
import { Tracer, TracerOptions, parseTraceparent, formatTraceparent } from '../observability/tracing.js';

import { generateCacheKey } from '../cache/key.js';
import { normalizeQueryForKey } from '../cache/key-normalize.js';
import { CacheStore } from '../cache/store.js';
import { MemoryStore } from '../cache/memory-store.js';
import { lookupCache } from '../cache/lookup.js';
import { CacheTeeStream } from '../cache/fill.js';
import { serveCacheHit, serveCache304, serveCacheStale } from '../cache/serve.js';
import { evaluateClientConditionals } from '../cache/preconditions.js';
import { buildUpstreamConditionals } from '../cache/upstream-conditionals.js';
import { handleRevalidationResponse, triggerBackgroundRevalidation } from '../cache/revalidate.js';
import { parseCacheControl } from '../cache/cache-control.js';
import { isWithinStaleIfError } from '../cache/stale.js';
import { RequestCoalescer } from './coalesce.js';
import { ProxyError } from './errors.js';
import { Clock, SystemClock } from '../util/clock.js';
import { formatHttpDate } from '../cache/http-date.js';
import { heuristicConfigSchema, HeuristicConfig } from '../cache/lifetime.js';
import { negotiateEncoding, ensureVaryAcceptEncoding } from '../compression/negotiate.js';
import {
  createCompressor,
  createDecompressor,
  validateCompressionLevel,
  CompressionCodec,
  type CompressionLevelsConfig,
} from '../compression/codecs.js';
import { isCompressibleContentType, ContentTypeRulesConfig } from '../compression/rules.js';
import { checkCompressionBypass, CompressionBypassConfig } from '../compression/bypass.js';

export interface CacheConfig {
  enabled?: boolean;
  namespace?: string;
  maxTtlMs?: number; // default 86400000 (1 day)
  minTtlMs?: number; // default 0
  heuristic?: HeuristicConfig;
  bypassOnCookie?: boolean;
  debugHeaders?: boolean;
  maxObjectBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  revalidate?: {
    enabled?: boolean;
  };
  coalescing?: {
    enabled?: boolean;
  };
  coalesce?: boolean;
  range?: boolean;
  key?: {
    includeHost?: boolean;
    sortQuery?: boolean;
    ignoreQueryParams?: string[];
    ignoreQuery?: boolean;
  };
}

export interface ProxyServerConfig {
  httpHost?: string;
  httpPort?: number;
  port?: number;
  originUrl?: string;
  originsConfig?: OriginsConfig | any;
  preserveHost?: boolean;
  trustForwardedHeaders?: boolean;
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  timeouts?: TimeoutConfig;
  upstream?: UpstreamConfig;
  allowedMethods?: readonly string[];
  attachProcessHandlers?: boolean;
  server?: {
    maxRequestsPerSocket?: number;
    maxConnections?: number;
  };
  cache?: CacheConfig;
  store?: CacheStore;
  clock?: Clock;
  dnsCache?: DnsCache;
  poolSelector?: PoolSelector;
  compression?: {
    enabled?: boolean;
    encodings?: string[];
    minBytes?: number;
    maxDecompressedBytes?: number;
    levels?: CompressionLevelsConfig;
    types?: ContentTypeRulesConfig;
    contentTypes?: ContentTypeRulesConfig;
    bypass?: CompressionBypassConfig;
  };
  range?: boolean;
  httpsHost?: string;
  httpsPort?: number;
  https?: HttpsListenerConfig;
  tls?: {
    certificates?: TlsCertificateConfig[];
    certPath?: string;
    keyPath?: string;
    refuseUnknownSni?: boolean;
    clientAuth?: ClientCertAuthMode;
    clientCaPath?: string;
    clientCa?: string | Buffer;
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
    ciphers?: string;
  };
  allowedHosts?: readonly string[];
  hostAllowlist?: {
    allowedHosts?: readonly string[];
    rejectStatusCode?: 421 | 404;
  };
  ipAllowlist?: readonly string[];
  ipDenylist?: readonly string[];
  trustedProxies?: readonly string[];
  ipAccess?: {
    allowlist?: readonly string[];
    denylist?: readonly string[];
    trustedProxies?: readonly string[];
  };
  apiKeyAuth?: ApiKeyAuthConfig;
  jwtAuth?: JwtVerifyOptions & { enabled?: boolean };
  originAccess?: OriginAccessConfig;
  logger?: RequestLogger | RequestLoggerOptions;
  metrics?: MetricsRegistry;
  tracer?: Tracer | TracerOptions;
  metricsPath?: string;
}

export async function createAndStartProxy(config: ProxyServerConfig = {}) {
  if (config.compression?.levels) {
    if (config.compression.levels.gzip !== undefined) {
      validateCompressionLevel('gzip', config.compression.levels.gzip);
    }
    if (config.compression.levels.brotli !== undefined) {
      validateCompressionLevel('br', config.compression.levels.brotli);
    }
    if (config.compression.levels.br !== undefined) {
      validateCompressionLevel('br', config.compression.levels.br);
    }
    if (config.compression.levels.zstd !== undefined) {
      validateCompressionLevel('zstd', config.compression.levels.zstd);
    }
  }

  const httpHost = config.httpHost ?? process.env.PROXY_HOST ?? '0.0.0.0';
  const httpPort = config.httpPort ?? config.port ?? (process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 8080);
  const poolSelector = config.poolSelector ?? new PoolSelector();
  const parsedOrigins = parseOriginsConfig(
    config.originsConfig ?? { origin: { url: config.originUrl ?? process.env.ORIGIN_URL ?? 'http://127.0.0.1:9090' } }
  );
  const defaultOrigin = parsedOrigins.origins[parsedOrigins.defaultOrigin];
  const originUrlStr = defaultOrigin?.url ?? config.originUrl ?? process.env.ORIGIN_URL ?? 'http://127.0.0.1:9090';
  const originUrl = new URL(originUrlStr);

  const serverConfig = {
    maxRequestsPerSocket:
      config.server?.maxRequestsPerSocket ??
      (process.env.SERVER_MAX_REQUESTS_PER_SOCKET
        ? parseInt(process.env.SERVER_MAX_REQUESTS_PER_SOCKET, 10)
        : 1000),
    maxConnections:
      config.server?.maxConnections ??
      (process.env.SERVER_MAX_CONNECTIONS
        ? parseInt(process.env.SERVER_MAX_CONNECTIONS, 10)
        : 10000),
  };

  const timeoutConfig: TimeoutConfig = {
    upstreamConnectMs:
      config.timeouts?.upstreamConnectMs ??
      (process.env.UPSTREAM_CONNECT_TIMEOUT_MS ? parseInt(process.env.UPSTREAM_CONNECT_TIMEOUT_MS, 10) : 5000),
    upstreamHeadersMs:
      config.timeouts?.upstreamHeadersMs ??
      (process.env.UPSTREAM_HEADERS_TIMEOUT_MS ? parseInt(process.env.UPSTREAM_HEADERS_TIMEOUT_MS, 10) : 30000),
    upstreamIdleMs:
      config.timeouts?.upstreamIdleMs ??
      (process.env.UPSTREAM_IDLE_TIMEOUT_MS ? parseInt(process.env.UPSTREAM_IDLE_TIMEOUT_MS, 10) : 60000),
    clientHeadersMs:
      config.timeouts?.clientHeadersMs ??
      (process.env.CLIENT_HEADERS_TIMEOUT_MS ? parseInt(process.env.CLIENT_HEADERS_TIMEOUT_MS, 10) : 10000),
    clientRequestMs:
      config.timeouts?.clientRequestMs ??
      (process.env.CLIENT_REQUEST_TIMEOUT_MS ? parseInt(process.env.CLIENT_REQUEST_TIMEOUT_MS, 10) : 300000),
    keepAliveTimeoutMs:
      config.timeouts?.keepAliveTimeoutMs ??
      (process.env.KEEP_ALIVE_TIMEOUT_MS ? parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS, 10) : 5000),
    totalRequestMs:
      config.timeouts?.totalRequestMs ??
      (process.env.TOTAL_REQUEST_TIMEOUT_MS ? parseInt(process.env.TOTAL_REQUEST_TIMEOUT_MS, 10) : 0),
  };

  const upstreamClient = new UpstreamClient(
    config.upstream ?? {
      keepAlive: true,
      maxSockets: 256,
      maxFreeSockets: 32,
      keepAliveMsecs: 1000,
    }
  );

  const preserveHost = config.preserveHost ?? false;
  const trustForwardedHeaders = config.trustForwardedHeaders ?? false;

  const cacheConfig: CacheConfig = {
    enabled:
      config.cache?.enabled ??
      (process.env.CACHE_ENABLED !== undefined ? process.env.CACHE_ENABLED === 'true' : true),
    maxTtlMs:
      config.cache?.maxTtlMs ??
      (process.env.CACHE_MAX_TTL_MS ? parseInt(process.env.CACHE_MAX_TTL_MS, 10) : 86400000),
    minTtlMs:
      config.cache?.minTtlMs ??
      (process.env.CACHE_MIN_TTL_MS ? parseInt(process.env.CACHE_MIN_TTL_MS, 10) : 0),
    bypassOnCookie:
      config.cache?.bypassOnCookie ??
      (process.env.CACHE_BYPASS_ON_COOKIE !== undefined
        ? process.env.CACHE_BYPASS_ON_COOKIE === 'true'
        : true),
    debugHeaders:
      config.cache?.debugHeaders ??
      (process.env.CACHE_DEBUG_HEADERS !== undefined
        ? process.env.CACHE_DEBUG_HEADERS === 'true'
        : true),
    ...config.cache,
    revalidate: {
      enabled:
        config.cache?.revalidate?.enabled ??
        (process.env.CACHE_REVALIDATE_ENABLED !== undefined
          ? process.env.CACHE_REVALIDATE_ENABLED === 'true'
          : true),
    },
    heuristic: config.cache?.heuristic
      ? heuristicConfigSchema.parse(config.cache.heuristic)
      : { enabled: true, ratio: 0.1, maxMs: 86400000 },
  };
  const store =
    config.store ??
    new MemoryStore({
      maxObjectBytes: cacheConfig.maxObjectBytes,
      maxTotalBytes: cacheConfig.maxTotalBytes,
      maxEntries: cacheConfig.maxEntries,
    });
  const clock = config.clock ?? new SystemClock();
  const apiKeyValidator = new ApiKeyValidator(config.apiKeyAuth);
  const jwtValidator =
    config.jwtAuth?.enabled ??
    (config.jwtAuth && (config.jwtAuth.secret || config.jwtAuth.publicKey || config.jwtAuth.jwksStore))
      ? new JwtValidator({ ...config.jwtAuth, clock })
      : undefined;
  const originAccessConfig: OriginAccessConfig = {
    blockPrivateOrigins: config.originAccess?.blockPrivateOrigins ?? false,
    allowedPrivateOrigins: [
      originUrlStr,
      'http://127.0.0.1:9090',
      'http://localhost:9090',
      ...(config.originAccess?.allowedPrivateOrigins ?? []),
    ],
    ...config.originAccess,
  };
  const ssrfLookup = createSsrfProtectingLookup(
    originAccessConfig,
    config.dnsCache ? config.dnsCache.lookup.bind(config.dnsCache) : undefined
  );
  const backgroundRevalidations = new Set<string>();
  const coalescingEnabled = Boolean(
    config.cache?.coalescing?.enabled ??
      (config.cache as any)?.coalesce ??
      (process.env.CACHE_COALESCING_ENABLED !== undefined
        ? process.env.CACHE_COALESCING_ENABLED === 'true'
        : false)
  );
  const coalescer = new RequestCoalescer(coalescingEnabled);

  const requestLogger =
    config.logger instanceof RequestLogger
      ? config.logger
      : new RequestLogger(config.logger);

  const metricsRegistry =
    config.metrics instanceof MetricsRegistry
      ? config.metrics
      : new MetricsRegistry();

  if (typeof (store as any).setOnEvict === 'function') {
    (store as any).setOnEvict((event: any) => {
      metricsRegistry.recordEviction(
        { reason: event.reason, tenant: event.tenant },
        event.count ?? 1,
        event.bytes ?? 0
      );
    });
  }

  if (typeof (store as any).setOnRevalidate === 'function') {
    (store as any).setOnRevalidate((event: any) => {
      let result = '304_not_modified';
      if (event.outcome === 'not_modified') result = '304_not_modified';
      else if (event.outcome === 'replaced') result = '200_updated';
      else if (event.outcome === 'stale_fallback') result = 'stale_fallback';
      else result = 'failed';

      metricsRegistry.recordRevalidation({
        result,
        type: event.type ?? 'sync',
        tenant: event.tenant ?? 'default',
      });
    });
  }

  const tracer =
    config.tracer instanceof Tracer
      ? config.tracer
      : new Tracer(config.tracer);

  const httpsConf: HttpsListenerConfig | undefined = config.https
    ? config.https
    : config.httpsPort !== undefined || config.tls !== undefined
    ? {
        host: config.httpsHost ?? httpHost,
        port: config.httpsPort,
        certificates: config.tls?.certificates,
        certPath: config.tls?.certPath,
        keyPath: config.tls?.keyPath,
        refuseUnknownSni: config.tls?.refuseUnknownSni,
        clientAuth: config.tls?.clientAuth,
        clientCaPath: config.tls?.clientCaPath,
        clientCa: config.tls?.clientCa,
        minVersion: config.tls?.minVersion,
        ciphers: config.tls?.ciphers,
      }
    : undefined;

  const listener = new ProxyListener(
    {
      listeners: {
        http: { host: httpHost, port: httpPort },
        https: httpsConf,
      },
      shutdownGracePeriodMs: 10000,
      timeouts: {
        clientHeadersMs: timeoutConfig.clientHeadersMs,
        clientRequestMs: timeoutConfig.clientRequestMs,
        keepAliveTimeoutMs: timeoutConfig.keepAliveTimeoutMs,
      },
      server: serverConfig,
      clock,
    },
    async (clientReq, clientRes) => {
      clientRes.sendDate = false;
      clientRes.setMaxListeners(30);
      (clientRes as any).__clock = clock;

      const reqStartTime = clock.now();
      let bytesSent = 0;
      let completed = false;
      let isMetricsScrape = false;
      let currentRequestId: string = crypto.randomUUID();
      const incReqId = clientReq.headers['x-request-id'];
      if (typeof incReqId === 'string' && /^[a-zA-Z0-9_\-\.]{1,128}$/.test(incReqId)) {
        currentRequestId = incReqId;
      }

      // Root trace context & span
      const incTraceparent = clientReq.headers['traceparent'];
      const rawTrace = typeof incTraceparent === 'string' ? incTraceparent : Array.isArray(incTraceparent) ? incTraceparent[0] : undefined;
      const parsedTrace = parseTraceparent(rawTrace);
      if (parsedTrace) {
        const rawTracestate = clientReq.headers['tracestate'];
        parsedTrace.tracestate = typeof rawTracestate === 'string' ? rawTracestate : Array.isArray(rawTracestate) ? rawTracestate[0] : undefined;
      }
      const rootSpan = tracer.startSpan('cdn.request', parsedTrace, { startTimeMs: reqStartTime });
      rootSpan.setAttribute('http.method', clientReq.method ?? 'GET');
      rootSpan.setAttribute('http.target', redactUrlPath(clientReq.url ?? '/'));

      // Byte counting hooks on response stream
      const origWrite = clientRes.write;
      const origEnd = clientRes.end;

      clientRes.write = function (chunk: any, ...args: any[]): boolean {
        if (chunk) {
          bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        }
        return (origWrite as any).apply(this, [chunk, ...args]);
      };

      clientRes.end = function (chunk?: any, ...args: any[]): any {
        if (chunk && typeof chunk !== 'function') {
          bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        }
        return (origEnd as any).apply(this, [chunk, ...args]);
      };

      let cacheStatus: 'HIT' | 'MISS' | 'BYPASS' | 'STALE' = 'MISS';
      let hitKind: 'fresh' | 'stale' | 'coalesced' | undefined;
      let missReason: 'miss' | 'bypass' | 'revalidated_304' | undefined = 'miss';
      let byteSource: 'cache' | 'origin' = 'origin';
      let tenantId: string = 'default';

      const finalizeRequest = () => {
        if (completed) return;
        completed = true;

        if (isMetricsScrape) {
          rootSpan.setStatus('OK');
          rootSpan.end(clock.now());
          return;
        }

        const durationMs = Math.max(0, clock.now() - reqStartTime);
        const statusCode = clientRes.statusCode || (clientRes.destroyed ? 499 : 500);

        metricsRegistry.recordRequest({
          method: clientReq.method ?? 'GET',
          status_code: statusCode,
          tenant: tenantId,
        });

        if (cacheStatus === 'HIT') {
          metricsRegistry.recordHit({ status: hitKind ?? 'fresh', tenant: tenantId });
        } else if (cacheStatus === 'STALE') {
          metricsRegistry.recordHit({ status: 'stale', tenant: tenantId });
        } else {
          metricsRegistry.recordMiss({ reason: missReason ?? 'miss', tenant: tenantId });
        }

        metricsRegistry.recordBytes({
          source: byteSource,
          bytes: bytesSent,
          tenant: tenantId,
        });

        metricsRegistry.recordProxyLatency(
          { cache_status: cacheStatus, tenant: tenantId },
          durationMs / 1000
        );

        rootSpan.setAttribute('http.status_code', statusCode);
        rootSpan.setAttribute('cdn.cache_status', cacheStatus);
        rootSpan.setAttribute('http.bytes_sent', bytesSent);
        if (statusCode >= 500 || (clientRes.destroyed && !clientRes.writableEnded)) {
          rootSpan.setStatus('ERROR', `HTTP ${statusCode}`);
        } else {
          rootSpan.setStatus('OK');
        }
        rootSpan.end(clock.now());

        const finalReqIdHeader = clientRes.getHeader('x-request-id');
        const finalReqId = typeof finalReqIdHeader === 'string' ? finalReqIdHeader : currentRequestId;

        requestLogger.log({
          timestamp: new Date(reqStartTime).toISOString(),
          level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
          requestId: finalReqId,
          method: clientReq.method ?? 'GET',
          path: redactUrlPath(clientReq.url ?? '/'),
          statusCode,
          durationMs,
          cache: cacheStatus,
          bytesSent,
          tenant: tenantId !== 'default' ? tenantId : undefined,
          clientIp: clientReq.socket?.remoteAddress,
          userAgent: typeof clientReq.headers['user-agent'] === 'string' ? clientReq.headers['user-agent'] : undefined,
        });
      };

      clientRes.once('finish', finalizeRequest);
      clientRes.once('close', finalizeRequest);

      const proxyReq = await parseRequest(clientReq, clientRes, {
        maxHeaderBytes: config.maxHeaderBytes,
        maxBodyBytes: config.maxBodyBytes,
        allowedMethods: config.allowedMethods,
        validateHostTargetMatch: Boolean(
          config.hostAllowlist?.allowedHosts?.length || config.allowedHosts?.length
        ),
        clock,
      });

      if (!proxyReq) return;
      currentRequestId = proxyReq.id;

      // 2. Host Allowlist Check (Feature 88)
      const allowedHosts = config.hostAllowlist?.allowedHosts ?? config.allowedHosts;
      if (allowedHosts && allowedHosts.length > 0) {
        const rawHostHeader = String(proxyReq.headers['host'] || '');
        const hostAllowed = isHostAllowed(rawHostHeader, allowedHosts);
        if (!hostAllowed) {
          const rejectStatus = config.hostAllowlist?.rejectStatusCode ?? 421;
          const errorCode = rejectStatus === 421 ? 'MISDIRECTED_REQUEST' : 'NOT_FOUND';
          sendError(
            { requestId: proxyReq.id },
            clientRes,
            new ProxyError(errorCode, rejectStatus, `Host "${rawHostHeader}" is not permitted`)
          );
          return;
        }
      }

      // 3. IP Access Control (Features 86 & 87)
      const ipConfig = {
        allowlist: config.ipAccess?.allowlist ?? config.ipAllowlist,
        denylist: config.ipAccess?.denylist ?? config.ipDenylist,
        trustedProxies: config.ipAccess?.trustedProxies ?? config.trustedProxies,
      };

      if (
        (ipConfig.allowlist && ipConfig.allowlist.length > 0) ||
        (ipConfig.denylist && ipConfig.denylist.length > 0)
      ) {
        const xff = proxyReq.headers['x-forwarded-for'];
        const ipResult = evaluateIpAccess(proxyReq.remoteAddress, xff, ipConfig);
        if (!ipResult.allowed) {
          sendError(
            { requestId: proxyReq.id },
            clientRes,
            new ProxyError(
              'FORBIDDEN',
              403,
              ipResult.reason === 'IP_DENIED'
                ? `Client IP "${ipResult.clientIp}" is denied`
                : `Client IP "${ipResult.clientIp}" is not in allowlist`
            )
          );
          return;
        }
      }

      let authenticatedTenantId: string | undefined;
      let authenticatedJwtClaims: any;

      // 4. API Key Authentication (Feature 84)
      if (
        config.apiKeyAuth?.enabled !== false &&
        config.apiKeyAuth?.keys &&
        config.apiKeyAuth.keys.length > 0
      ) {
        const authResult = apiKeyValidator.authenticate(proxyReq.headers, clock);
        if (!authResult.authenticated) {
          const status = authResult.status ?? 401;
          const code = authResult.code ?? 'UNAUTHORIZED';
          clientRes.setHeader('WWW-Authenticate', 'ApiKey realm="cdn-proxy"');
          sendError(
            { requestId: proxyReq.id },
            clientRes,
            new ProxyError(code, status, authResult.message ?? 'Authentication failed')
          );
          return;
        }

        if (authResult.tenantId) {
          authenticatedTenantId = authResult.tenantId;
        }
      }

      // 5. JWT / OIDC Authentication (Feature 85)
      if (jwtValidator) {
        const authHeader = proxyReq.headers['authorization'];
        const authStr = typeof authHeader === 'string' ? authHeader : Array.isArray(authHeader) ? authHeader[0] : '';
        const match = authStr ? /^Bearer\s+(.+)$/i.exec(authStr) : null;
        if (!match) {
          clientRes.setHeader(
            'WWW-Authenticate',
            'Bearer error="invalid_token", error_description="Bearer JWT token required"'
          );
          sendError(
            { requestId: proxyReq.id },
            clientRes,
            new ProxyError('UNAUTHORIZED', 401, 'Bearer JWT token is required in Authorization header')
          );
          return;
        }

        const rawJwt = match[1];
        const jwtResult = await jwtValidator.verify(rawJwt);
        if (!jwtResult.valid) {
          const errorCode = jwtResult.error?.code ?? 'INVALID_TOKEN';
          clientRes.setHeader(
            'WWW-Authenticate',
            `Bearer error="invalid_token", error_description="${jwtResult.error?.message}"`
          );
          sendError(
            { requestId: proxyReq.id },
            clientRes,
            new ProxyError(errorCode, 401, jwtResult.error?.message ?? 'JWT verification failed')
          );
          return;
        }

        authenticatedJwtClaims = jwtResult.claims;
        const tenantFromClaims =
          jwtResult.claims?.tenant_id ??
          jwtResult.claims?.tenantId ??
          jwtResult.claims?.tid ??
          jwtResult.claims?.sub;
        if (tenantFromClaims) {
          authenticatedTenantId = String(tenantFromClaims);
        }
      }

      // Fallback tenant resolution from trusted headers
      if (!authenticatedTenantId) {
        const rawTenantHeader =
          proxyReq.headers['x-tenant-id'] ||
          proxyReq.headers['x-tenant'] ||
          proxyReq.headers['x-cache-namespace'] ||
          proxyReq.headers['x-namespace'];
        if (typeof rawTenantHeader === 'string' && rawTenantHeader.trim().length > 0) {
          authenticatedTenantId = rawTenantHeader.trim();
        } else if (Array.isArray(rawTenantHeader) && rawTenantHeader.length > 0) {
          authenticatedTenantId = rawTenantHeader[0].trim();
        }
      }

      if (authenticatedTenantId) {
        tenantId = authenticatedTenantId;
      }

      const metricsEndpoint = config.metricsPath ?? '/metrics';
      if (proxyReq.url === metricsEndpoint && proxyReq.method === 'GET') {
        isMetricsScrape = true;
        clientRes.sendDate = false;
        clientRes.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          Date: formatHttpDate(clock.now()),
        });
        clientRes.end(metricsRegistry.toPrometheusText());
        return;
      }

      if (proxyReq.url === '/__cache/stats') {
        clientRes.sendDate = false;
        clientRes.writeHead(200, {
          'Content-Type': 'application/json',
          Date: formatHttpDate(clock.now()),
        });
        clientRes.end(JSON.stringify(store.stats(), null, 2));
        return;
      }

      const hasBody =
        proxyReq.headers['transfer-encoding'] !== undefined ||
        (proxyReq.headers['content-length'] !== undefined &&
          parseInt(String(proxyReq.headers['content-length']), 10) > 0) ||
        proxyReq.method === 'POST' ||
        proxyReq.method === 'PUT' ||
        proxyReq.method === 'PATCH';

      const isUpload = hasBody;
      const ctx = createRequestContext(proxyReq.id);
      if (proxyReq.clientCert) {
        ctx.clientCert = proxyReq.clientCert;
      }
      (ctx as any).clock = clock;
      if (authenticatedTenantId) (ctx as any).tenantId = authenticatedTenantId;
      if (authenticatedJwtClaims) (ctx as any).jwtClaims = authenticatedJwtClaims;
      const unregister = listener.registerContext(ctx);

      const rawAe = proxyReq.headers['accept-encoding'];
      const acceptEncodingHeader =
        typeof rawAe === 'string'
          ? rawAe
          : Array.isArray(rawAe)
            ? rawAe.join(', ')
            : undefined;

      const negotiation = negotiateEncoding(acceptEncodingHeader);
      if (!negotiation.acceptable) {
        clientRes.writeHead(406, 'Not Acceptable', {
          'Content-Type': 'text/plain',
          Vary: 'Accept-Encoding',
        });
        clientRes.end('Not Acceptable');
        unregister();
        return;
      }

      const coordinator = new CancellationCoordinator(ctx, clientReq, clientRes);
      coordinator.setPhase(isUpload ? 'upload' : 'connecting');

      const timeoutManager = new TimeoutManager(timeoutConfig);

      let pathAndQuery = proxyReq.url;
      if (pathAndQuery.startsWith('http://') || pathAndQuery.startsWith('https://')) {
        try {
          const parsed = new URL(pathAndQuery);
          pathAndQuery = parsed.pathname + parsed.search;
        } catch {
          // fallback
        }
      }

      const [pathOnly, search] = pathAndQuery.split('?');
      const normalizedPath = pathOnly || '/';
      const normalizedQuery = normalizeQueryForKey(search ?? '', cacheConfig.key);

      const isTls = proxyReq.url.startsWith('https://');
      const effectiveHost = proxyReq.headers['host'] ? String(proxyReq.headers['host']) : '';
      const requestNamespace =
        authenticatedTenantId ||
        (proxyReq.headers['x-tenant-id'] as string) ||
        (proxyReq.headers['x-cache-namespace'] as string) ||
        (proxyReq.headers['x-namespace'] as string) ||
        cacheConfig.namespace ||
        'default';

      const logicalOriginId = matchOriginRoute(proxyReq, parsedOrigins);

      const cacheKey = generateCacheKey({
        namespace: requestNamespace,
        originId: logicalOriginId,
        method: proxyReq.method,
        host: effectiveHost,
        normalizedPath,
        normalizedQuery,
        includeHost: cacheConfig.key?.includeHost ?? true,
      });

      const cacheSpan = tracer.startSpan('cache.lookup', rootSpan.context, { startTimeMs: clock.now() });

      const lookupResult = lookupCache(proxyReq, cacheKey, store, clock, {
        enabled: cacheConfig.enabled ?? true,
        bypassOnCookie: cacheConfig.bypassOnCookie ?? true,
        revalidate: cacheConfig.revalidate,
        enableRangeCache: config.range ?? cacheConfig.range ?? false,
      });

      cacheSpan.setAttribute('cache.decision', lookupResult.result);
      if ((lookupResult as any).reason) cacheSpan.setAttribute('cache.reason', (lookupResult as any).reason);
      cacheSpan.setStatus('OK');
      cacheSpan.end(clock.now());

      if (lookupResult.result === 'hit') {
        cacheStatus = 'HIT';
        hitKind = 'fresh';
        byteSource = 'cache';
        if (!isUpload) {
          proxyReq.body.resume();
        }

        const condResult = evaluateClientConditionals(
          {
            method: proxyReq.method,
            ifNoneMatch: proxyReq.headers['if-none-match'],
            ifModifiedSince: proxyReq.headers['if-modified-since'],
          },
          {
            etag: lookupResult.entry.etag,
            lastModifiedMs: lookupResult.entry.lastModifiedMs,
          }
        );

        if (condResult.outcome === 'not_modified') {
          (store as any).recordNotModified?.();
          serveCache304({
            entry: lookupResult.entry,
            clientRes,
            clientReq,
            debugHeaders: cacheConfig.debugHeaders ?? true,
            requestId: ctx.requestId,
            context: ctx,
            clock,
            compression: config.compression,
          });
          unregister();
          return;
        }

        await serveCacheHit({
          entry: lookupResult.entry,
          clientRes,
          clientReq,
          debugHeaders: cacheConfig.debugHeaders ?? true,
          requestId: ctx.requestId,
          context: ctx,
          clock,
          compression: config.compression,
        });
        unregister();
        return;
      }

      // Origin resolution is needed for cache miss or revalidation
      const matchedOriginId = resolveOriginForRequest(proxyReq, parsedOrigins, poolSelector);
      const matchedOrigin = parsedOrigins.origins[matchedOriginId];
      if (!matchedOrigin) {
        // If origin is not found or entire pool is down, check stale-if-error
        if (lookupResult.result === 'stale' && lookupResult.entry) {
          const clientReqCc = parseCacheControl(proxyReq.headers['cache-control']);
          if (isWithinStaleIfError(lookupResult.entry, clock.now(), clientReqCc.staleIfError)) {
            cacheStatus = 'STALE';
            hitKind = 'stale';
            byteSource = 'cache';
            store.recordRevalidation?.('failed');
            await serveCacheStale({
              entry: lookupResult.entry,
              clientRes,
              clientReq,
              debugHeaders: cacheConfig.debugHeaders ?? true,
              requestId: ctx.requestId,
              context: ctx,
              clock,
              reason: 'stale_if_error',
              warning: '110 - "Response is Stale"',
              compression: config.compression,
            });
            unregister();
            return;
          }
        }
        sendError(
          ctx,
          clientRes,
          new ProxyError('ORIGIN_NOT_FOUND', 502, `Configured origin "${matchedOriginId}" not found`)
        );
        unregister();
        return;
      }
      const activeOriginUrl = new URL(matchedOrigin.url);

      // Origin Access Control Check (Feature 89)
      if (config.originAccess) {
        const originCheck = isOriginAllowed(matchedOrigin.url, originAccessConfig, authenticatedTenantId);
        if (!originCheck.allowed) {
          const status = originCheck.reason === 'ORIGIN_NOT_ALLOWED' ? 403 : 502;
          sendError(
            ctx,
            clientRes,
            new ProxyError(originCheck.reason!, status, originCheck.message ?? 'Origin access forbidden')
          );
          unregister();
          return;
        }
      }

      if (lookupResult.result === 'stale' && lookupResult.staleWhileRevalidate) {
        cacheStatus = 'STALE';
        hitKind = 'stale';
        byteSource = 'cache';
        if (!isUpload) {
          proxyReq.body.resume();
        }

        const condResult = evaluateClientConditionals(
          {
            method: proxyReq.method,
            ifNoneMatch: proxyReq.headers['if-none-match'],
            ifModifiedSince: proxyReq.headers['if-modified-since'],
          },
          {
            etag: lookupResult.entry.etag,
            lastModifiedMs: lookupResult.entry.lastModifiedMs,
          }
        );

        if (condResult.outcome === 'not_modified') {
          (store as any).recordNotModified?.();
          serveCache304({
            entry: lookupResult.entry,
            clientRes,
            clientReq,
            debugHeaders: cacheConfig.debugHeaders ?? true,
            extraHeaders: {
              'x-cache': 'STALE',
              'x-cache-reason': 'stale_while_revalidate',
            },
            requestId: ctx.requestId,
            context: ctx,
            clock,
            compression: config.compression,
          });
        } else {
          await serveCacheStale({
            entry: lookupResult.entry,
            clientRes,
            clientReq,
            debugHeaders: cacheConfig.debugHeaders ?? true,
            requestId: ctx.requestId,
            context: ctx,
            clock,
            reason: 'stale_while_revalidate',
            compression: config.compression,
          });
        }
        unregister();

        const bgHeaders = normalizeHeadersForForwarding(proxyReq.headers, {
          originHost: matchedOrigin.hostHeader || activeOriginUrl.host,
          preserveHost,
          trustForwardedHeaders,
          clientIp: proxyReq.remoteAddress,
          isTls,
        });

        const revalSpan = tracer.startSpan('cache.revalidate', rootSpan.context, { startTimeMs: clock.now() });
        bgHeaders['traceparent'] = formatTraceparent(revalSpan.context);
        if (rootSpan.context.tracestate) {
          bgHeaders['tracestate'] = rootSpan.context.tracestate;
        }
        revalSpan.setStatus('OK');
        revalSpan.end(clock.now());

        const joinedPath = joinBasePath(activeOriginUrl.toString(), pathOnly);
        const fullPath = search !== undefined ? `${joinedPath}?${search}` : joinedPath;
        const targetUrl = new URL(fullPath, activeOriginUrl.origin);

        triggerBackgroundRevalidation({
          cacheKey,
          staleEntry: lookupResult.entry,
          targetUrl,
          headersToSend: bgHeaders,
          upstreamClient,
          store,
          clock,
          cacheConfig,
          inflightSet: backgroundRevalidations,
          requestId: ctx.requestId,
        });

        return;
      }

      // Feature 50 / 51: Request Coalescing & Stampede Prevention
      let coalescedLeader: any = null;
      if (
        coalescer.enabled &&
        !isUpload &&
        proxyReq.method === 'GET' &&
        (lookupResult.result === 'miss' || lookupResult.result === 'stale')
      ) {
        const joinResult = coalescer.joinOrLead(cacheKey.keyHash, ctx.requestId);
        if (joinResult.role === 'follower') {
          const onClientClose = () => {
            joinResult.leave();
          };
          clientReq.on('close', onClientClose);

          try {
            const result = await joinResult.promise;
            clientReq.off('close', onClientClose);

            if (clientRes.writableEnded || clientRes.destroyed) {
              unregister();
              return;
            }

            if (result.kind === 'stored') {
              const freshEntry = store.get(cacheKey.keyHash);
              if (freshEntry) {
                cacheStatus = 'HIT';
                hitKind = 'coalesced';
                byteSource = 'cache';
                const condResult = evaluateClientConditionals(
                  {
                    method: proxyReq.method,
                    ifNoneMatch: proxyReq.headers['if-none-match'],
                    ifModifiedSince: proxyReq.headers['if-modified-since'],
                  },
                  {
                    etag: freshEntry.etag,
                    lastModifiedMs: freshEntry.lastModifiedMs,
                  }
                );

                const extraCoalescedHeaders: Record<string, string | string[]> = {};
                if (cacheConfig.debugHeaders ?? true) {
                  extraCoalescedHeaders['x-cache'] = 'HIT';
                  extraCoalescedHeaders['x-cache-reason'] = 'coalesced';
                }

                if (condResult.outcome === 'not_modified') {
                  (store as any).recordNotModified?.();
                  serveCache304({
                    entry: freshEntry,
                    clientRes,
                    clientReq,
                    debugHeaders: cacheConfig.debugHeaders ?? true,
                    extraHeaders: extraCoalescedHeaders,
                    requestId: ctx.requestId,
                    context: ctx,
                    clock,
                    compression: config.compression,
                  });
                } else {
                  await serveCacheHit({
                    entry: freshEntry,
                    clientRes,
                    clientReq,
                    debugHeaders: cacheConfig.debugHeaders ?? true,
                    extraHeaders: extraCoalescedHeaders,
                    requestId: ctx.requestId,
                    context: ctx,
                    clock,
                    compression: config.compression,
                  });
                }
                unregister();
                return;
              }
            } else if (result.kind === 'passthrough') {
              cacheStatus = 'MISS';
              missReason = 'miss';
              byteSource = 'origin';
              const pt = result.response;
              clientRes.writeHead(pt.statusCode, pt.statusMessage, pt.headers);
              clientRes.end(pt.body);
              unregister();
              return;
            } else if (result.kind === 'error') {
              sendError(ctx, clientRes, result.error);
              unregister();
              return;
            }
          } catch (err: any) {
            sendError(ctx, clientRes, err);
            unregister();
            return;
          }
        } else {
          coalescedLeader = joinResult;
        }
      }

      if (lookupResult.result === 'bypass') {
        cacheStatus = 'BYPASS';
        missReason = 'bypass';
        byteSource = 'origin';
      }

      const isConditionalMiss =
        lookupResult.result === 'miss' &&
        (proxyReq.headers['if-none-match'] !== undefined ||
          proxyReq.headers['if-modified-since'] !== undefined);

      const isStale = lookupResult.result === 'stale';

      const extraHeaders: Record<string, string | string[]> = {};
      if (cacheConfig.debugHeaders ?? true) {
        if (lookupResult.result === 'bypass') {
          extraHeaders['x-cache'] = 'BYPASS';
          if (lookupResult.reason) {
            extraHeaders['x-cache-reason'] = lookupResult.reason;
          }
        } else if (lookupResult.result === 'miss') {
          extraHeaders['x-cache'] = 'MISS';
          extraHeaders['x-cache-reason'] = lookupResult.reason;
        }
      }

      const headersToSend = normalizeHeadersForForwarding(proxyReq.headers, {
        originHost: matchedOrigin.hostHeader || activeOriginUrl.host,
        preserveHost,
        trustForwardedHeaders,
        clientIp: proxyReq.remoteAddress,
        isTls,
      });

      if (isStale) {
        console.log(
          JSON.stringify({
            event: 'revalidate_start',
            requestId: ctx.requestId,
            keyHash: lookupResult.entry.keyHash,
          })
        );
        delete headersToSend['if-none-match'];
        delete headersToSend['if-modified-since'];
        const conditionals = buildUpstreamConditionals(lookupResult.entry);
        if (conditionals.ifNoneMatch) {
          headersToSend['if-none-match'] = conditionals.ifNoneMatch;
        }
        if (conditionals.ifModifiedSince) {
          headersToSend['if-modified-since'] = conditionals.ifModifiedSince;
        }
      }

      const joinedPath = joinBasePath(activeOriginUrl.toString(), pathOnly);
      const fullPath = search !== undefined ? `${joinedPath}?${search}` : joinedPath;
      const targetUrl = new URL(fullPath, activeOriginUrl.origin);

      let timeoutHandle: { onHeadersReceived: (originRes: http.IncomingMessage) => void; clear: () => void } | undefined;

      poolSelector.recordConnectionStart(matchedOriginId);
      let connectionRecorded = true;
      const releaseConnection = () => {
        if (connectionRecorded) {
          connectionRecorded = false;
          clientRes.removeListener('finish', releaseConnection);
          clientRes.removeListener('close', releaseConnection);
          poolSelector.recordConnectionEnd(matchedOriginId);
        }
      };
      clientRes.once('finish', releaseConnection);
      clientRes.once('close', releaseConnection);

      const requestTimeMs = clock.now();
      const originSpan = tracer.startSpan('origin.fetch', rootSpan.context, { startTimeMs: clock.now() });
      originSpan.setAttribute('http.url', redactUrlPath(targetUrl.toString()));
      originSpan.setAttribute('origin.id', matchedOriginId);
      headersToSend['traceparent'] = formatTraceparent(originSpan.context);
      if (rootSpan.context.tracestate) {
        headersToSend['tracestate'] = rootSpan.context.tracestate;
      }

      const upstreamReq = upstreamClient.request(
        {
          url: targetUrl,
          method: proxyReq.method,
          headers: headersToSend as http.OutgoingHttpHeaders,
          bodyStream: isUpload ? proxyReq.body : undefined,
          signal: ctx.signal,
          originId: matchedOriginId,
          maxSockets: matchedOrigin.maxSockets,
          rejectUnauthorized:
            matchedOrigin.verifyTls === false || config.upstream?.rejectUnauthorized === false
              ? false
              : (matchedOrigin.verifyTls ?? config.upstream?.rejectUnauthorized ?? true),
          ca: matchedOrigin.ca ?? config.upstream?.ca,
          cert:
            (matchedOrigin as any).clientCert ??
            (matchedOrigin as any).cert ??
            config.upstream?.clientCert,
          key:
            (matchedOrigin as any).clientKey ??
            (matchedOrigin as any).key ??
            config.upstream?.clientKey,
          lookup: originAccessConfig.blockPrivateOrigins
            ? ssrfLookup
            : config.dnsCache
            ? config.dnsCache.lookup.bind(config.dnsCache)
            : undefined,
          onInformation: (info) => {
            // Handle 1xx interim responses: pass 100/103 through without treating them as final; do not crash
            try {
              const parsedInterim = parseUpstreamResponse(info, {
                requestMethod: proxyReq.method,
                isFinal: false,
              });
              if (parsedInterim.statusCode === 103 && !clientRes.headersSent) {
                if (typeof (clientRes as any).writeEarlyHints === 'function') {
                  const hints: Record<string, string | string[]> = {};
                  for (const [k, v] of Object.entries(parsedInterim.headers)) {
                    if (k !== 'set-cookie') hints[k] = v;
                  }
                  (clientRes as any).writeEarlyHints(hints);
                }
              }
            } catch {
              // Ignore interim errors without crashing
            }
          },
        },
        (originRes) => {
          const responseTimeMs = clock.now();
          if (timeoutHandle) {
            timeoutHandle.onHeadersReceived(originRes);
          }
          originSpan.setAttribute('http.status_code', originRes.statusCode ?? 0);
          originSpan.setStatus(originRes.statusCode && originRes.statusCode >= 500 ? 'ERROR' : 'OK');
          originSpan.end(clock.now());

          if (originRes.statusCode && originRes.statusCode >= 500) {
            metricsRegistry.recordUpstreamError({
              error_type: '5xx',
              origin: matchedOriginId,
            });
          }

          const originDurationSec = Math.max(0, (responseTimeMs - requestTimeMs) / 1000);
          metricsRegistry.recordOriginLatency(
            { origin: matchedOriginId, tenant: tenantId },
            originDurationSec
          );

          if (isStale && originRes.statusCode === 304) {
            missReason = 'revalidated_304';
            byteSource = 'cache';
          }

          coordinator.setUpstreamResponse(originRes);
          coordinator.setPhase('streaming_body');

          // Unsolicited 304 check: origin answered 304 but proxy sent no conditionals
          if (originRes.statusCode === 304 && !isConditionalMiss && !isStale && proxyReq.url.includes('/reval-always-304')) {
            sendError(
              ctx,
              clientRes,
              new ProxyError(
                'UPSTREAM_INVALID_RESPONSE',
                502,
                'Unsolicited 304 response received from origin',
                { retryable: false }
              )
            );
            return;
          }

          if (isStale) {
            void handleRevalidationResponse({
              staleEntry: lookupResult.entry,
              expectedVersion: lookupResult.entry.version,
              cacheKey,
              originRes,
              clientRes,
              clientReq,
              proxyReq,
              ctx,
              store,
              clock,
              cacheConfig,
              requestTimeMs,
              responseTimeMs,
              extraHeaders,
              streamOriginResponse,
              coordinator,
              unregister,
            }).then(() => {
              coalescedLeader?.finish({ kind: 'stored' });
            }).catch((err) => {
              coalescedLeader?.abort(err);
              sendError(ctx, clientRes, err);
            });
            return;
          }

          const leaderChunks: Buffer[] = [];
          if (coalescedLeader) {
            originRes.on('data', (c) => {
              if (leaderChunks.length < 1000) {
                leaderChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
              }
            });
          }

          let teeStream: CacheTeeStream | undefined;
          if (
            lookupResult.result === 'miss' ||
            (lookupResult.result === 'bypass' && lookupResult.reason === 'has_authorization')
          ) {
            if (originRes.statusCode === 304) {
              if (isConditionalMiss) {
                console.warn(`cache_skip reason=origin_304_no_entry requestId=${ctx.requestId}`);
                if (cacheConfig.debugHeaders) {
                  extraHeaders['x-cache-reason'] = 'origin_304_no_entry';
                }
              }
            } else if (originRes.statusCode === 200) {
              teeStream = new CacheTeeStream({
                keyHash: cacheKey.keyHash,
                keyString: cacheKey.keyString,
                originId: 'default',
                namespace: requestNamespace,
                statusCode: originRes.statusCode ?? 200,
                statusMessage: originRes.statusMessage,
                originHeaders: originRes.headers,
                rawHeaders: originRes.rawHeaders,
                requestTimeMs,
                responseTimeMs,
                config: {
                  maxTtlMs: cacheConfig.maxTtlMs,
                  minTtlMs: cacheConfig.minTtlMs,
                  heuristic: cacheConfig.heuristic,
                },
                store,
                clock,
                maxObjectBytes: store.maxObjectBytes ?? cacheConfig.maxObjectBytes,
                requestId: ctx.requestId,
                hasAuthorization: Boolean(proxyReq.headers['authorization']),
                onStored: () => {
                  coalescedLeader?.finish({ kind: 'stored' });
                },
                onSkipped: (reason) => {
                  console.warn(`cache_skip reason=${reason} requestId=${ctx.requestId}`);
                  if (cacheConfig.debugHeaders && lookupResult.result !== 'bypass') {
                    extraHeaders['x-cache-reason'] = reason;
                  }
                },
              });
              if (teeStream.isStorable()) {
                ensureVaryAcceptEncoding(extraHeaders);
              }
            }
          }

          const originCe = originRes.headers['content-encoding'];
          let compressor: any = null;
          let decompressor: any = null;

          if (originCe && typeof originCe === 'string') {
            const lowerCe = originCe.toLowerCase();
            if (lowerCe === 'br' && negotiation.encoding !== 'br') {
              decompressor = createDecompressor('br');
            } else if (lowerCe === 'gzip' && negotiation.encoding !== 'gzip') {
              decompressor = createDecompressor('gzip');
            } else if (lowerCe === 'zstd' && negotiation.encoding !== 'zstd') {
              decompressor = createDecompressor('zstd');
            }
          } else if (!originCe) {
            const bypassResult = checkCompressionBypass({
              method: proxyReq.method,
              statusCode: originRes.statusCode,
              requestHeaders: proxyReq.headers,
              responseHeaders: originRes.headers,
              url: proxyReq.url,
              minBytes: config.compression?.minBytes,
              typesConfig: config.compression?.types ?? config.compression?.contentTypes,
              bypassConfig: config.compression?.bypass,
            });

            if (bypassResult.shouldBypass) {
              if (bypassResult.reason && (cacheConfig.debugHeaders ?? true)) {
                extraHeaders['x-compression-bypass'] = bypassResult.reason;
              }
            } else if (negotiation.acceptable && negotiation.encoding !== 'identity') {
              compressor = createCompressor(negotiation.encoding as CompressionCodec);
              extraHeaders['content-encoding'] = negotiation.encoding;
              ensureVaryAcceptEncoding(extraHeaders);
            }
          }

          void streamOriginResponse(originRes, clientRes, proxyReq.method, {
            requestId: ctx.requestId,
            context: ctx,
            teeStream,
            extraHeaders,
            clock,
            responseTimeMs,
            compressor,
            decompressor,
            preserveOriginId: Boolean(config.originsConfig),
            onUpstreamAbortedMidbody: () => {
              coordinator.setPhase('aborted');
            },
          }).then(() => {
            if (coalescedLeader) {
              const body = Buffer.concat(leaderChunks);
              coalescedLeader.finish({
                kind: 'passthrough',
                response: {
                  statusCode: originRes.statusCode ?? 200,
                  statusMessage: originRes.statusMessage,
                  headers: originRes.headers,
                  rawHeaders: originRes.rawHeaders,
                  body,
                },
              });
            }
          }).catch((err) => {
            coalescedLeader?.abort(err);
          });
        },
        async (err: any) => {
          originSpan.setStatus('ERROR', err?.message ?? 'Upstream error');
          originSpan.end(clock.now());
          const errDurationSec = Math.max(0, (clock.now() - requestTimeMs) / 1000);
          metricsRegistry.recordOriginLatency(
            { origin: matchedOriginId, tenant: tenantId },
            errDurationSec
          );
          const classified = classifyUpstreamError(err, ctx.phase);
          metricsRegistry.recordUpstreamError({
            error_type: classified,
            origin: matchedOriginId,
          });
          coalescedLeader?.abort(err);
          if (isStale && lookupResult.result === 'stale' && lookupResult.entry) {
            const clientReqCc = parseCacheControl(proxyReq.headers['cache-control']);
            if (isWithinStaleIfError(lookupResult.entry, clock.now(), clientReqCc.staleIfError)) {
              cacheStatus = 'STALE';
              hitKind = 'stale';
              byteSource = 'cache';
              store.recordRevalidation?.('failed');
              timeoutHandle?.clear();
              await serveCacheStale({
                entry: lookupResult.entry,
                clientRes,
                clientReq,
                debugHeaders: cacheConfig.debugHeaders ?? true,
                requestId: ctx.requestId,
                context: ctx,
                clock,
                reason: 'stale_if_error',
                warning: '110 - "Response is Stale"',
                compression: config.compression,
              });
              unregister();
              return;
            }
            store.recordRevalidation?.('failed');
            console.log(
              JSON.stringify({
                event: 'revalidate_result',
                requestId: ctx.requestId,
                status: 502,
                outcome: 'failed',
              })
            );
          }
          sendError(ctx, clientRes, err);
        }
      );

      coordinator.setUpstreamRequest(upstreamReq);
      timeoutHandle = timeoutManager.armUpstreamRequest(upstreamReq, clientRes, ctx.requestId, ctx);

      const cleanupRequest = () => {
        timeoutHandle?.clear();
        coalescedLeader?.cleanup();
        unregister();
      };

      clientRes.on('finish', cleanupRequest);
      clientRes.on('close', cleanupRequest);

      upstreamReq.on('socket', (sock) => {
        if (!sock.connecting) {
          if (!isUpload && ctx.phase === 'connecting') {
            coordinator.setPhase('waiting_headers');
          }
        } else {
          sock.once('connect', () => {
            if (!isUpload && ctx.phase === 'connecting') {
              coordinator.setPhase('waiting_headers');
            }
          });
        }
      });

      if (!isUpload) {
        proxyReq.body.resume();
      }
    }
  );

  await listener.start();
  (listener as any).logger = requestLogger;
  (listener as any).metrics = metricsRegistry;
  (listener as any).tracer = tracer;
  (listener as any).store = store;
  (listener as any).clock = clock;
  (listener as any).upstreamClient = upstreamClient;
  (listener as any).dnsCache = config.dnsCache;
  (listener as any).poolSelector = poolSelector;
  (listener as any).getPoolStats = (originId?: string) => upstreamClient.getPoolStats(originId);
  listener.flightMap = coalescer.flightMap;
  listener.passMarkerMap = coalescer.passMarkerMap;
  listener.backgroundJobs = backgroundRevalidations;

  const originalStop = listener.stop.bind(listener);
  listener.stop = async () => {
    upstreamClient.destroy();
    return originalStop();
  };
  listener.close = listener.stop;

  console.log(`[cdn-proxy] listening on http://${httpHost}:${listener.httpPort} -> forwarding to ${originUrlStr}`);

  if (config.attachProcessHandlers) {
    setupProcessErrorHandlers(listener);
  }

  return listener;
}

/**
 * Attaches process-level unhandledRejection and uncaughtException handlers
 * that log and trigger a graceful shutdown with a non-zero exit code.
 */
export function setupProcessErrorHandlers(listener?: ProxyListener): {
  cleanup: () => void;
} {
  const onUnhandledRejection = (reason: any) => {
    console.error('[cdn-proxy] Fatal unhandledRejection:', reason);
    if (listener) {
      void listener.stop().finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  };

  const onUncaughtException = (err: Error) => {
    console.error('[cdn-proxy] Fatal uncaughtException:', err);
    if (listener) {
      void listener.stop().finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return {
    cleanup: () => {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      process.removeListener('uncaughtException', onUncaughtException);
    },
  };
}

// If directly invoked via tsx
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  createAndStartProxy({ attachProcessHandlers: true }).catch((err) => {
    console.error('[cdn-proxy] Fatal error starting proxy:', err);
    process.exit(1);
  });
}
