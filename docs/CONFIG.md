# CDN Caching Proxy - Configuration Reference

This document describes all configuration sections, keys, types, and default values supported by the CDN caching proxy.

---

## 1. Listeners (`listeners`)

| Key | Type | Default | Description |
|---|---|---|---|
| `listeners.http.host` | `string` | `"0.0.0.0"` | Bind IP address for the HTTP listener. |
| `listeners.http.port` | `number` | `8080` | Bind port for the HTTP listener. Port `0` binds to an ephemeral OS-assigned port. |
| `listeners.https.host` | `string` | `"0.0.0.0"` | Bind IP address for the HTTPS listener (optional). |
| `listeners.https.port` | `number` | `8443` | Bind port for the HTTPS listener. |
| `listeners.https.keyPath` | `string` | *(required if https)* | Absolute or relative path to TLS private key PEM file. |
| `listeners.https.certPath`| `string` | *(required if https)* | Absolute or relative path to TLS certificate PEM file. |
| `shutdownGracePeriodMs` | `number` | `10000` (10s) | Grace period to drain in-flight connections on SIGINT/SIGTERM before force-destroying sockets. |

---

## 2. Upstream (`upstream`)

| Key | Type | Default | Description |
|---|---|---|---|
| `origin.url` | `string` | *(required)* | Base URL for origin server (e.g. `http://127.0.0.1:9090` or `https://origin.internal`). |
| `upstream.keepAlive` | `boolean` | `true` | Enables HTTP keep-alive connection pooling for upstream connections. |
| `upstream.maxSockets` | `number` | `256` | Maximum number of concurrent active sockets allowed per origin host. |
| `upstream.maxFreeSockets` | `number` | `32` | Maximum number of idle sockets left open in the free socket pool. |
| `upstream.keepAliveMsecs`| `number` | `1000` | Initial delay for TCP Keep-Alive probes sent upstream. |
| `preserveHost` | `boolean` | `false` | When `false`, sends origin host in upstream `Host` header. When `true`, preserves client's requested `Host`. |
| `trustForwardedHeaders` | `boolean` | `false` | When `false`, discards incoming `X-Forwarded-*` headers to prevent IP/proto spoofing. |

---

## 3. Timeouts (`timeouts`)

| Key | Type | Default | Error Code / Behavior | Description |
|---|---|---|---|---|
| `timeouts.upstreamConnectMs` | `number` | `5000` (5s) | `504 UPSTREAM_CONNECT_TIMEOUT` | Max duration allowed to establish TCP connection (and TLS handshake) to origin. |
| `timeouts.upstreamHeadersMs` | `number` | `30000` (30s) | `504 UPSTREAM_HEADERS_TIMEOUT` | Max duration from request dispatched until origin response headers are received. |
| `timeouts.upstreamIdleMs` | `number` | `60000` (60s) | Client socket destroyed (`UPSTREAM_IDLE_TIMEOUT`) | Max idle duration between streamed body chunks from origin. |
| `timeouts.clientHeadersMs` | `number` | `10000` (10s) | Server socket reset | Slowloris protection: max time allowed for client to finish sending HTTP headers. |
| `timeouts.clientRequestMs` | `number` | `300000` (5m) | Server socket reset | Max total time allowed for client request receipt. |
| `timeouts.keepAliveTimeoutMs` | `number` | `5000` (5s) | Client socket closed | Inactivity timeout on client keep-alive connection before server closes it. |
| `timeouts.totalRequestMs` | `number` | `0` (disabled) | `504 TOTAL_REQUEST_TIMEOUT` | Hard deadline for entire request lifecycle (0 = disabled). |

---

## 4. Limits (`limits`)

| Key | Type | Default | Status Code | Description |
|---|---|---|---|---|
| `maxHeaderBytes` | `number` | `16384` (16 KB) | `431 HEADERS_TOO_LARGE` | Maximum total byte length of raw HTTP request headers. |
| `maxBodyBytes` | `number` | `10485760` (10 MB) | `413 PAYLOAD_TOO_LARGE` | Maximum request body size. Set to `0` for unlimited. |

---

## 5. Origins Configuration (`origins`)

| Key | Type | Default | Description |
|---|---|---|---|
| `origins` | `Record<string, OriginEntry>` | `{ default: { url: "http://127.0.0.1:9090", verifyTls: true } }` | Map of origin IDs to origin definitions. |
| `origins.<id>.url` | `string` | *(required)* | Origin base URL (`http:` or `https:`). Credentials, query parameters, and fragments are rejected. Base paths are supported (e.g. `https://api.example.com/v1`). |
| `origins.<id>.hostHeader` | `string` | *(optional)* | Custom `Host` header to send upstream in `host[:port]` format. |
| `origins.<id>.verifyTls` | `boolean` | `true` | Validates TLS certificate on HTTPS origins. |
| `origins.<id>.maxSockets` | `number` | `256` | Maximum concurrent sockets for this origin. |
| `origins.<id>.timeouts` | `object` | *(optional)* | Per-origin timeout overrides for any timeout key. |
| `defaultOrigin` | `string` | `"default"` | ID of the default origin in `origins`. |

### Precedence Rules
Configuration values are loaded with the following precedence order:
1. **Environment Variables**: e.g. `ORIGIN_URL` overrides default origin URL; `UPSTREAM_HEADERS_TIMEOUT_MS`, etc.
2. **Configuration File**: JSON config specifying `origins` map or legacy `origin.url`.
3. **Defaults**: Built-in system defaults.

### Configuration Validation CLI
To validate a configuration file without running the proxy:
```bash
npm run config:check -- [config-path.json]
```
Returns exit code `0` on success and prints the effective configuration with secrets/passwords redacted (`******`), or returns exit code `1` with human-readable error messages pointing to the exact config path.

---

## 6. Server & Keep-Alive (`server`)

| Key | Type | Default | Description |
|---|---|---|---|
| `server.maxRequestsPerSocket` | `number` | `1000` | Maximum requests served on a single persistent client connection. The response to the last allowed request carries `Connection: close` and the socket is closed after completion. |
| `server.maxConnections` | `number` | `10000` | Maximum number of concurrent client TCP sockets accepted by the server. |
| `timeouts.keepAliveTimeoutMs` | `number` | `5000` (5s) | Inactivity timeout on an idle client keep-alive connection before the server terminates the socket. |

### Keep-Alive Behavior
- **HTTP/1.1**: Connections are persistent by default unless the client sends `Connection: close`.
- **HTTP/1.0**: Connections close by default unless the client explicitly sends `Connection: keep-alive`.
- **Graceful Shutdown Drain**: Upon shutdown, the server stops accepting new connections, immediately invokes `server.closeIdleConnections()` to terminate idle pooled sockets, attaches `Connection: close` to any in-flight requests completing during drain, and force-destroys any remaining sockets after the grace period (`shutdownGracePeriodMs`).
- **Upstream Keep-Alive**: When an origin responds with `Connection: close`, the upstream HTTP agent immediately removes that socket from the connection pool and will not reuse it for subsequent requests.

---

## 7. HTTP Method Handling (`allowedMethods`)

| Key | Type | Default | Description |
|---|---|---|---|
| `allowedMethods` | `string[]` | `["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]` | List of allowed HTTP methods. |

### Method Handling Rules
- **Disallowed Recognized Methods**: A recognized HTTP method (e.g., `TRACE`, `CONNECT`) that is not in `allowedMethods` returns `405 Method Not Allowed` with an `Allow` header listing the allowed methods.
- **Why TRACE and CONNECT are Denied**: This proxy is a reverse caching proxy, not a forward proxy or arbitrary tunneling gateway. `CONNECT` is used for forward proxy HTTPS tunneling and poses security risks in a reverse proxy. `TRACE` is disabled to prevent Cross-Site Tracing (XST) attacks.
- **Unknown Method Tokens**: Unrecognized or lowercase method tokens (e.g., `FOO`, `get`) return `501 Not Implemented`. Methods are strictly case-sensitive per RFC 9110.
- **Asterisk-form `OPTIONS *`**: Requests using asterisk-form target (`OPTIONS *`) are answered directly by the proxy with `200 OK`, `Content-Length: 0`, and an `Allow` header, without contacting the origin. Target-specific options (`OPTIONS /path`) are forwarded to the origin as normal.
- **Bodies on GET / HEAD / DELETE / OPTIONS**: RFC 9110 does not define semantics for bodies on these methods; the proxy transparently forwards any received request bodies to the origin.
- **Expect: 100-continue**: Handled natively by Node.js HTTP parser. Clients sending `Expect: 100-continue` receive `100 Continue` once initial headers are accepted, and the proxy streams the full uploaded body to the origin.

---

## 8. Error Handling & Taxonomy

All proxy-generated errors return a structured JSON response:
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human-readable safe error message",
    "requestId": "4e27e1e4-9e04-43e3-a68e-fae18cd945d1"
  }
}
```
- **Headers**: Responses carry `Content-Type: application/json`, `Cache-Control: no-store`, `X-Request-Id: <id>`, and `Connection: close`.
- **HEAD requests**: Error responses to HEAD requests return identical status and headers without the JSON body.
- **No Leaks**: Error responses never expose stack traces, internal filesystem paths (`/Users`, `.ts`, `node_modules`), origin hostnames, or internal IPs. Detailed diagnostics are logged server-side with the associated `requestId`.

### Error Codes
- `BAD_REQUEST` (400)
- `INVALID_TARGET` (400)
- `HEADERS_TOO_LARGE` (431)
- `PAYLOAD_TOO_LARGE` (413)
- `METHOD_NOT_ALLOWED` (405)
- `NOT_IMPLEMENTED` (501)
- `UPSTREAM_CONNECT_FAILED` (502)
- `UPSTREAM_DNS_FAILED` (502)
- `UPSTREAM_CONNECTION_RESET` (502)
- `UPSTREAM_TLS_ERROR` (502)
- `UPSTREAM_INVALID_RESPONSE` (502)
- `UPSTREAM_CONNECT_TIMEOUT` (504)
- `UPSTREAM_HEADERS_TIMEOUT` (504)
- `UPSTREAM_IDLE_TIMEOUT` (504)
- `INTERNAL_ERROR` (500)
- `SERVICE_UNAVAILABLE` (503)

---

## 7. Cache Configuration (`cache`)

| Key | Type | Default | Description |
|---|---|---|---|
| `cache.enabled` | `boolean` | `true` | Enables or disables the cache lookup, miss fill, and hit serve pipeline. |
| `cache.namespace` | `string` | `"default"` | Logical namespace partition for cache keys (allows tenant isolation without key format migration). |
| `cache.maxTtlMs` | `number` | `86400000` (24h / 1 day) | Safety ceiling capping the maximum freshness lifetime calculated from origin response headers. **Note**: This is an operational safety limit and is NOT part of the HTTP specification. |
| `cache.minTtlMs` | `number` | `0` | Floor configuration (default 0; origin freshness is never artificially raised). |
| `cache.defaultTtlMs` | `number` | *Removed* | **Deprecated in Batch 5**. Ignored if present in legacy configs (a deprecation warning is logged; does not crash). Freshness is dynamically computed per RFC 9111. |
| `cache.bypassOnCookie` | `boolean` | `true` | Bypasses caching if the incoming client request contains a `Cookie` header. |
| `cache.debugHeaders` | `boolean` | `true` | Sends diagnostic `X-Cache: HIT`, `X-Cache: MISS`, `X-Cache: BYPASS`, `X-Cache: REVALIDATED`, `X-Cache-Reason: <reason>`, and calculated `Age` headers. Never exposes internal keys or hashes. |
| `cache.revalidate.enabled` | `boolean` | `true` | When true, stale entries with validators are revalidated synchronously upstream. When false, stale entries are deleted on lookup and treated as plain misses. |
| `cache.maxObjectBytes` | `number` | `5242880` (5 MB) | Maximum size of an individual response body eligible for caching. Objects larger than this limit are cleanly rejected (not stored, no partial state, no eviction triggered). Streaming responses exceeding this limit drop buffering mid-stream, stream untouched to client, and log `cache_skip reason=too_large`. |
| `cache.maxTotalBytes` | `number` | `268435456` (256 MB) | Maximum total body bytes retained in the memory store. When capacity is exceeded, entries are evicted via the active eviction policy until strictly within budget. |
| `cache.maxEntries` | `number` | `10000` | Maximum number of cache entries. When reached, entries are evicted via the active eviction policy until strictly within budget. |
| `cache.evictionPolicy` | `"lru" \| "lfu"` | `"lru"` | Eviction algorithm used when capacity or entry budgets are exceeded. `lru` evicts least recently accessed entries first. `lfu` evicts lowest access frequency entries first (deterministic tie-break: oldest last-access timestamp, then lexicographical key hash). |
| `cache.key.includeHost` | `boolean` | `true` | When true, includes the lowercased effective `Host` (default ports stripped) in the cache key. When false, host is omitted from the key. |
| `cache.key.sortQuery` | `boolean` | `true` | Stably sorts query parameters by name while preserving relative order of duplicate names (`?a=2&a=1` stays `a=2, a=1`). |
| `cache.key.ignoreQueryParams` | `string[]` | `[]` | List of query parameter names to strip from the cache key. Entries ending in `*` perform prefix matching (e.g. `utm_*`). Normalized name comparison is case-sensitive. |
| `cache.key.ignoreQuery` | `boolean` | `false` | When true, ignores the entire query string during cache key generation. **WARNING**: This is dangerous because different URLs returning distinct content will collapse into a single cache key. |
| `cache.heuristic.enabled` | `boolean` | `true` | Enables or disables RFC 9111 §4.2.2 heuristic freshness calculation based on `Last-Modified`. |
| `cache.heuristic.ratio` | `number` | `0.1` | Fraction of `(Date - Last-Modified)` to allocate as freshness lifetime (`0 < ratio <= 1`). |
| `cache.heuristic.maxMs` | `number` | `86400000` (24h) | Upper limit in milliseconds on heuristic freshness duration. |

### Cache Eviction & TTL Behavior (Batch 9)
- **Memory Store Separation**: Metadata index (O(1) Map lookup) is decoupled from byte-accurate object body storage.
- **Size Eviction (Feature 35)**: Whenever inserting or overwriting an entry causes total retained bytes or total entries to exceed `maxTotalBytes` or `maxEntries`, entries are evicted according to the configured `evictionPolicy` until capacity is within budget. A newly inserted entry is never evicted to make room for itself. Objects exceeding `maxObjectBytes` or `maxTotalBytes` are rejected cleanly without storing or evicting.
- **In-Flight & Lock Protection**: Entries with an active revalidation lock (`RevalidationLockManager`) or active in-flight coalesced fetch are protected and never evicted mid-operation.
- **TTL Eviction (Feature 34)**: Entries past their freshness lifetime are evaluated against RFC 5861 stale windows. An entry inside its `stale-while-revalidate` or `stale-if-error` window is **retained** and not evicted by TTL eviction. Only entries past all applicable stale windows (or expired entries with `must-revalidate`, `proxy-revalidate`, or `s-maxage` where stale serving is forbidden) are purged.
- **Streaming Safety**: Reads use an immutable body buffer reference; concurrent eviction, replacement, or deletion does not corrupt or truncate in-flight streamed client responses.

### RFC 9111 Freshness Lifetime Precedence Table (Shared Cache)

The proxy operates as a shared cache. Freshness lifetime is determined using the strict precedence order mandated by RFC 9111 §4.2.1:

| Precedence | Directive / Header | RFC 9111 Section | Calculation |
|---|---|---|---|
| 1 | `Cache-Control: s-maxage=N` | §5.2.2.10 | Lifetime is `N` seconds (converted to milliseconds, capped by `cache.maxTtlMs`). Overrides `max-age`, `Expires`, and heuristic freshness. |
| 2 | `Cache-Control: max-age=N` | §5.2.2.1 | Lifetime is `N` seconds (converted to milliseconds, capped by `cache.maxTtlMs`). Overrides `Expires` and heuristic freshness. |
| 3 | `Expires: <http-date>` | §5.3 | Lifetime is `parsedExpires - dateMs` (clamped to `>= 0`, capped by `cache.maxTtlMs`). Invalid date (e.g. "0" or malformed) represents already expired (lifetime 0). Ignored if `max-age` or `s-maxage` is present. Presence of `Expires` (even invalid) disables heuristic freshness. |
| 4 | `Last-Modified: <http-date>` (Heuristic) | §4.2.2 | Only when no `s-maxage`, `max-age`, or `Expires` is present, response is not `no-store`/`private`/`no-cache`, has a valid `lastModifiedMs`, and `lastModifiedMs <= dateValueMs`. `lifetime = min(floor(ratio * (dateValueMs - lastModifiedMs)), maxMs)`. |
| 5 | None | §4.2.2 | Responses without any freshness directives and without a usable `Last-Modified` result in lifetime 0 with source `"none"` and are never stored (`cache_skip reason=no_freshness_info`). |

---

## 8. Date Header Policy (Batch 6)

The proxy strictly controls the `Date` header on every outgoing response (disabling Node.js automatic date emission via `res.sendDate = false`):

| Response Type | Date Source | Behavior |
|---|---|---|
| **Proxied response (MISS & plain pass-through)** | Origin Date (if valid) or Proxy Clock | If origin sends exactly ONE valid `Date` header parseable by RFC 9110 IMF-fixdate / RFC 850 / asctime, forward byte-identical. If missing, invalid, or multiple, replace with `formatHttpDate(responseTime)` from Clock and log `date_missing` or `date_invalid`. |
| **Cache HIT** | Stored Date | Replay the stored Date unchanged (either origin Date or proxy-added Date stored at fill time). The stored Date does not advance as time elapses, maintaining consistency with `Age`. Stored metadata tracks `dateSource: "origin" \| "proxy_added"`. |
| **Proxy-generated response** | Proxy Clock | All proxy errors (400, 405, 501, 502, 504), `OPTIONS *`, and cache `304 Not Modified` receive `Date: formatHttpDate(now)` from the injected Clock. |

---

## 9. Client Conditional Requests Evaluation (Batch 6)

In Batch 6, incoming `If-None-Match` and `If-Modified-Since` headers participate in cache lookup rather than triggering a BYPASS.

| Condition / Header | Precedence & Rule | Outcome on Fresh HIT | Outcome on MISS / Expired |
|---|---|---|---|
| **`If-None-Match: *`** | Matches any existing representation | Served from cache: `304 Not Modified`, no body, stored validators & headers replayed. | Forwarded upstream with conditional header intact; origin 200 response is now stored (Batch 7 fix). |
| **`If-None-Match: <tag-list>`** | Evaluated with weak comparison (`weakMatch`). Matches if entry has `etag` and any listed tag matches. | If match: `304 Not Modified`. If no match, or entry has no ETag: `200 OK` HIT with full response body. | Forwarded upstream with conditional header intact; origin 200 response is now stored. If origin answers 304 on true miss, passed through with `origin_304_no_entry`. |
| **`If-None-Match: <invalid>`** | Malformed entity tag syntax | Conservative fallback: `200 OK` HIT with full body. | Forwarded upstream with conditional header intact; passed through unstored. |
| **`If-Modified-Since: <http-date>`** | Evaluated **ONLY** when `If-None-Match` is **ABSENT**. Any INM (even invalid) disables IMS. | If entry has `lastModifiedMs` and `lastModifiedMs <= ifModifiedSinceMs`: `304 Not Modified`. Otherwise `200 OK` HIT with full body. | Forwarded upstream with conditional header intact; origin 200 response is now stored. |
| **Cache `304 Not Modified` response** | RFC 9110 §15.4.5 & RFC 9111 §4.3.4 | Status 304, zero body bytes. Headers include: stored `ETag`, `Last-Modified`, `Cache-Control`, `Expires`, `Content-Location`, stored `Date`, plus calculated `Age`, `Via`, and `X-Cache: HIT` (or `X-Cache: REVALIDATED`). All payload/entity headers (`Content-Length`, `Content-Type`, `Transfer-Encoding`, `Content-Range`) are stripped. | N/A |

---

## 10. Synchronous Revalidation & 304 Refresh (Batch 7)

When lookup encounters an expired entry that holds validators (`etagRaw` or `lastModifiedRaw`), and `cache.revalidate.enabled` is `true`, the proxy initiates synchronous upstream revalidation.

### Revalidation Decision Table

| Upstream Status / Outcome | Condition | Proxy Action | Cache Store Action | Client Response |
|---|---|---|---|---|
| **304 Not Modified** | Origin ETag matches stored ETag (weak comparison) | Header merge per RFC 9111 §3.2, freshness recomputed | Monotonic version checked; replaced in store with refreshed entry | Client conditionals evaluated against refreshed entry (`304` or `200` with `X-Cache: REVALIDATED`) |
| **304 Not Modified** | Origin ETag differs from stored ETag (mismatch) | Reject invalid upstream response | Stale entry deleted from store | `502 Bad Gateway` (`UPSTREAM_INVALID_RESPONSE`), no retry |
| **304 Not Modified** | Merged headers no longer storable (`no-store`, `private`, `max-age=0`) | Serve refreshed response once to this client | Stale entry deleted from store | `200 OK` with merged headers served once |
| **200 OK** | Origin sends new representation | Treated as miss fill with tee stream | Stale entry superseded/replaced if storable, or deleted if unstorable | `200 OK` streamed to client (`X-Cache: MISS`, `X-Cache-Reason: revalidated_replaced`) |
| **404 / 410** | Resource deleted/missing at origin | Pass origin response through to client | Stale entry deleted from store | `404` or `410` passed through |
| **Other 3xx / 4xx** | Other client/redirect status | Pass origin response through to client | Stale entry kept untouched in store | Origin status passed through |
| **5xx Server Error** | Origin failure (500, 502, 503, 504) | Pass origin 5xx through to client | Stale entry kept untouched in store (never served stale) | Origin 5xx passed through |
| **Connect / Timeout Failure** | Connection refused, reset, headers timeout | Send error response through taxonomy | Stale entry kept untouched in store (never served stale) | `502` or `504` JSON error |
| **Unsolicited 304** | 304 received when proxy sent no conditional headers | Reject unsolicited 304 | Nothing stored | `502 Bad Gateway` (`UPSTREAM_INVALID_RESPONSE`) |

### RFC 9111 Section 3.2 Header Merge Rules on 304 Refresh

Upon receiving a valid 304, the stored response headers are updated:
- Every header present in the 304 replaces all stored instances of that header.
- **Excluded Headers** (never taken from a 304):
  - Hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`)
  - Content headers: `content-length`, `content-encoding`, `content-range`, `content-type`
  - Protocol state headers: `set-cookie`, `vary`, `age`, `via`
  - Any header listed in the 304's `Connection` header
- **Date Header**: The 304's `Date` is used if exactly one valid IMF-fixdate is present; otherwise the proxy Clock Date is synthesized.
- **Body & Identity**: Stored status, statusMessage, body Buffer (exact reference and byte contents), and storedAt are preserved unchanged.

### Never-Serve-Stale Policy & `allowsStaleServing` Hook

Under RFC 9111 and this proxy's architecture:
- Stale responses are served ONLY when an explicit policy allows it (RFC 5861 `stale-while-revalidate` or `stale-if-error`).
- If revalidation fails without a policy allowing stale serving (or when `must-revalidate`, `proxy-revalidate`, or `s-maxage` is present), the proxy returns an error (`502` / `504`) or passes through the origin 5xx, and never falls back to the stale body.
- The pure function `allowsStaleServing(entry): boolean` in `src/cache/stale.ts` enforces that entries with `must-revalidate`, `proxy-revalidate`, or `s-maxage` can never be served stale under any circumstances.

---

## 11. Request Coalescing, Stampede Prevention & Stale Serving (Batch 8)

| Key | Type | Default | Description |
|---|---|---|---|
| `cache.coalescing.enabled` | `boolean` | `false` | When `true`, enables in-flight request deduplication (collapsed forwarding / request coalescing) and stampede prevention. |
| `cache.coalescing.waitTimeoutMs` | `number` | `5000` (5s) | Maximum duration a follower request will wait on the leader before timing out and falling back to a direct origin fetch. |

### Feature Summary

1. **Request Coalescing (Feature 50)**:
   - When multiple concurrent misses arrive for the exact same cache key, exactly one leader request is dispatched to the upstream origin.
   - Followers register on the in-flight leader's promise and wait.
   - When the leader completes and stores the cache entry, all waiting followers are served directly from the newly stored cache entry as `HIT`.
   - If the leader receives a non-storable response, followers receive an independent direct pass-through without hanging.
   - If the leader fails, the error propagates to all followers.

2. **Stampede Prevention (Feature 51)**:
   - Resolves thundering herds on cache expiry: concurrent requests for an expired entry coalesce so that only 1 conditional revalidation request reaches the origin.
   - If the origin returns `304 Not Modified`, freshness is refreshed and all followers receive the refreshed entry.
   - If the origin returns `200 OK` (replacement), the leader buffers and stores the new body chunks before resolving followers, guaranteeing all waiting clients receive the updated body.

3. **Background Revalidation (Feature 41)**:
   - Async revalidation job runner reusing conditional-request generation and RFC 9111 Section 3.2 304 header merge logic.
   - Tracks active background jobs and cleans up upon completion.

4. **Revalidation Locks (Feature 49)**:
   - Per-key mutual exclusion lock manager (`RevalidationLockManager`).
   - Ensures that only one revalidation (synchronous or background) can run for a given cache key at any time.
   - Locks are strictly per-key, never global.
   - Guaranteed automatic release on success, error, timeout, or cancellation (`AbortSignal`).

5. **Stale-While-Revalidate (Feature 26, RFC 5861 §3)**:
   - When an entry is within its `stale-while-revalidate` window (`age < freshnessLifetime + staleWhileRevalidate`), the proxy immediately delivers the stale cached representation to the client (`X-Cache: STALE`, `Warning: 110`).
   - Asynchronously triggers exactly one background revalidation job under a per-key lock.
   - Outside the window, falls back to synchronous revalidation.

6. **Stale Serving (Feature 44, RFC 9111 §4.2.4 & RFC 5861)**:
   - Stale responses calculate and include RFC compliant `Age` headers, `Via`, and `Warning: 110 "Response is Stale"`.
   - `must-revalidate`, `proxy-revalidate`, and `s-maxage` strictly override and forbid stale serving.

7. **Stale-If-Error (Feature 145, RFC 5861 §4)**:
   - When upstream revalidation returns a 5xx error (500, 502, 503, 504), network connection failure, or timeout:
   - If the cached representation is within its `stale-if-error` window and `must-revalidate`/`proxy-revalidate`/`s-maxage` is not set, the proxy delivers the stale cached entry to the client with `Warning: 110`.
   - Beyond the window or when forbidden, the origin error/timeout is returned to the client without masking.

---

## 12. Disk Cache, Persistence, Segmentation, Namespaces & Quotas (Batch 10)

| Key | Type | Default | Description |
|---|---|---|---|
| `cache.storage` | `'memory' \| 'disk'` | `'memory'` | Selects the backing cache storage backend. `'disk'` activates `DiskStore`. |
| `cache.diskPath` | `string` | `undefined` | Absolute directory path where persistent cache files (`.cache`) are stored. |
| `cache.maxObjectBytes` | `number` | `5242880` (5 MB) | Maximum size of an individual cacheable object in bytes. Oversized objects are rejected cleanly. |
| `cache.maxTotalBytes` | `number` | `268435456` (256 MB) | Global maximum storage capacity across all cached objects in bytes. |
| `cache.maxEntries` | `number` | `10000` | Global maximum entry count before eviction triggers. |
| `cache.evictionPolicy` | `'lru' \| 'lfu' \| 'slru' \| 'none'` | `'lru'` | Eviction algorithm. `'slru'` enables Segmented LRU with scan resistance. |
| `cache.protectedRatio` | `number` | `0.8` (80%) | Protected segment capacity fraction for Segmented LRU (`slru`). Remainder is probation segment. |
| `cache.namespace` | `string` | `'default'` | Default cache namespace. Can be overridden per-request via `X-Cache-Namespace` or `X-Namespace`. |
| `cache.tenantQuotas` | `Record<string, { maxTotalBytes?: number; maxEntries?: number }>` | `{}` | Per-tenant storage budgets. Tenants over quota evict only their own entries. |

### Architecture & Mechanisms

1. **Disk Cache & Atomic Writes (Feature 28)**:
   - Disk-backed object store conforming to `CacheStore` interface.
   - Objects are written atomically using unique temporary files (`.<keyHash>.<timestamp>.<random>.tmp`) in the cache directory, flushed, and renamed into `<hexKeyHash>.cache`.
   - Binary file layout: 48-byte header (`8B magic CDNCACHE` + `4B metaLen` + `4B bodyLen` + `32B sha256 checksum`) followed by JSON metadata and raw response body.
   - On read, the proxy validates the 48-byte header and calculates SHA-256 over `[metaBuf + bodyBuf]`. Any flipped byte or corrupt file is detected, cleanly unlinked, evicted from index, and served as a cache miss without crashing.

2. **Persistent Cache & Recovery (Feature 29)**:
   - Rebuilds metadata index (`MetadataIndex`) and live byte totals from disk files on startup via `rebuildIndex()`.
   - Evaluates each `.cache` file header and checksum; truncated or corrupt entries are silently dropped and unlinked.
   - Orphan `.tmp` files left behind by aborted writes or crashes are purged automatically on startup.
   - Entries are restored into eviction policies in strict chronological access order (`lastAccessedAt`).

3. **Segmented Cache / SLRU (Feature 36)**:
   - Segmented Least Recently Used (`SlruPolicy`) separates cache storage into two segments:
     - **Probation Segment**: New entries enter probation. Scan resistance prevents one-hit wonders from evicting hot entries.
     - **Protected Segment**: Entries accessed at least twice are promoted from probation to protected.
   - Configurable `protectedRatio` (default 0.8 / 80%). When the protected segment fills, its least recently used entries are demoted back to probation. Eviction always picks from probation first.

4. **Key Namespaces & Isolation (Feature 37)**:
   - Requests specify their tenant/namespace via `X-Cache-Namespace` or `X-Namespace` HTTP request headers (fallback: config default).
   - Injective JSON array cache key serialization: `["v1", namespace, originId, method, host, path, query]`.
   - Eliminates delimiter ambiguity and collision vulnerabilities (e.g. namespace `"a:b"` + path `"/c"` vs namespace `"a"` + path `"/b:c"`).
   - `MetadataIndex` provides O(1) namespace querying (`getByNamespace`) and aggregated statistics (`getNamespaceStats`).

5. **Tenant Quotas & Isolated Eviction (Feature 38)**:
   - Enforces independent per-tenant capacity budgets on bytes (`maxTotalBytes`) and entry count (`maxEntries`).
   - When a tenant exceeds its quota, eviction is strictly scoped to victim entries matching that tenant's namespace. Other tenants' entries are never evicted.
   - An object larger than a tenant's entire quota is rejected cleanly with defined behavior.
   - Quota accounting remains exact across inserts, overwrites, deletes, evictions, and disk restarts.

6. **Object Limits & Clean Rejection (Feature 39)**:
   - Strict enforcement of `maxObjectBytes` and `maxEntries`.
   - Oversized objects return `false` on storage, increment `storeSkipped` metric, leave zero partial state or disk files, and do not evict existing entries.
   - Streaming responses (`CacheTeeStream`) inspect `Content-Length` or accumulated chunked body size. If `maxObjectBytes` is exceeded mid-stream, the internal buffer is immediately dropped to bound memory, while the client stream continues seamlessly to completion.

---

## 13. Origins, Pools, Weighted Routing, Connection Pooling & DNS Caching (Batch 11)

| Key | Type | Default | Description |
|---|---|---|---|
| `origins` | `Record<string, OriginEntry>` | `{ default: { url: "http://127.0.0.1:9090", verifyTls: true } }` | Registry of upstream origin endpoints. |
| `origins.<id>.url` | `string` | *(required)* | Upstream URL. Must be valid `http:` or `https:`. No userinfo, query, or fragment allowed. Path prefix supported. |
| `origins.<id>.hostHeader` | `string` | `undefined` | Custom `Host` header sent to this origin (`host[:port]`). |
| `origins.<id>.verifyTls` | `boolean` | `true` | Validates TLS certificate on HTTPS origins. Rejects self-signed or hostname mismatch when `true`. |
| `origins.<id>.ca` | `string \| Buffer` | `undefined` | Custom CA certificate PEM for private upstream PKI. |
| `origins.<id>.maxSockets` | `number` | `256` | Maximum concurrent active sockets allowed to this specific origin. |
| `origins.<id>.weight` | `number` | `1` | Default weight for this origin when participating in weighted pools. |
| `origins.<id>.timeouts` | `object` | `undefined` | Per-origin timeout overrides (`upstreamConnectMs`, `upstreamHeadersMs`, `upstreamIdleMs`). |
| `originRoutes` | `OriginRouteRule[]` | `[]` | Ordered routing rules mapping client requests to an origin or pool. |
| `originRoutes[i].pathPrefix` | `string` | `undefined` | Matches if request pathname starts with this prefix (e.g. `"/api/"`). |
| `originRoutes[i].pathPattern` | `RegExp \| string` | `undefined` | Regular expression matching against request pathname. |
| `originRoutes[i].host` | `string` | `undefined` | Matches client `Host` header (case-insensitive, ignoring port). |
| `originRoutes[i].header` | `{ name: string; value: string \| RegExp }` | `undefined` | Matches presence or exact/regex value of a specific incoming header. |
| `originRoutes[i].originId` | `string` | `undefined` | Destination origin ID when rule matches. |
| `originRoutes[i].poolId` | `string` | `undefined` | Destination pool ID when rule matches. |
| `originPools` | `Record<string, OriginPoolConfig>` | `{}` | Named groups of origins for load balancing. |
| `originPools.<id>.loadBalancing` | `'round-robin' \| 'least-connections' \| 'weighted'` | `'round-robin'` | Balancing policy across available pool members. |
| `originPools.<id>.members` | `Array<{ originId: string; weight?: number }>` | *(required)* | List of pool member origins and their relative weights. |
| `dnsCache` | `object` | `undefined` | DNS resolution cache configuration. |
| `dnsCache.ttlMs` | `number` | `30000` (30s) | In-memory DNS record cache TTL. |
| `dnsCache.minTtlMs` | `number` | `1000` (1s) | Minimum clamp on DNS record TTL. |
| `dnsCache.maxTtlMs` | `number` | `300000` (5m) | Maximum clamp on DNS record TTL. |
| `dnsCache.maxEntries` | `number` | `1000` | Maximum cached hostnames in DNS cache before LRU eviction. |

### Architecture & Mechanisms

1. **Origin Validation (Feature 48)**:
   - Validates origin URLs at configuration load time (`http:` or `https:`, no user credentials or queries).
   - Validates TLS certificates when `verifyTls: true`, rejecting expired certs, self-signed certs without custom CA, and hostname mismatches with descriptive error reporting.
   - Pre-flight reachability checks (`validateReachability`) verify connectivity to upstream endpoints on startup.

2. **Multiple Origins & Route Matching (Feature 54)**:
   - Request router evaluates configured `originRoutes` in first-match order.
   - Supports routing by `pathPrefix`, `pathPattern`, `host`, and `header`.
   - Unmatched requests fall back to `defaultOrigin`.
   - Path-prefixed origins cleanly join target URL paths with base paths without double slashes.

3. **Origin Pools (Feature 55)**:
   - Groups origin endpoints into named pools.
   - Routes can target a `poolId` directly; the proxy queries `PoolSelector` to resolve the active upstream endpoint for each request.

4. **Weighted Routing (Feature 56)**:
   - Distributes pool traffic proportional to member weights using smooth weighted round-robin.
   - Zero-weight members receive zero traffic; non-zero members receive requests in exact integer weight ratios.

5. **Connection Pooling (Feature 62)**:
   - `UpstreamClient` manages dedicated, isolated `http.Agent` and `https.Agent` pools per origin.
   - Enforces per-origin `maxSockets` and `keepAlive: true` with automatic reuse across requests.
   - Pool resources and sockets are completely torn down on server shutdown via `upstreamClient.destroy()`.

6. **DNS Caching (Feature 63)**:
   - In-memory `DnsCache` caches resolved IP addresses (`dns.lookup`) with configurable TTL and clamps.
   - Coalesces concurrent in-flight DNS lookups for the same hostname into a single resolver call.
   - Exposes cache statistics (`hits`, `misses`, `evictions`, `resolutions`).

7. **Load Balancing & Availability Hook (Feature 65)**:
   - `PoolSelector` supports `round-robin`, `least-connections`, and `weighted` policies.
   - Tracks active connections per origin via `incrementActiveConnections` / `decrementActiveConnections` in the proxy lifecycle.
   - Integrates with the `isAvailable(originId)` hook (for Batch 12 health checks / circuit breakers) to filter out unhealthy origins. If all origins in a pool are unavailable, the proxy safely returns `502 Bad Gateway`.

---

## 14. Health Checks, Failover, Circuit Breaker & DNS Refresh (Batch 12)

### Design & Architectural Principles

#### 1. Failure Classification
- **Counted as Origin Failures**:
  - Upstream timeouts (`UPSTREAM_CONNECT_TIMEOUT`, `UPSTREAM_HEADERS_TIMEOUT`, `UPSTREAM_IDLE_TIMEOUT`, socket timeouts)
  - Upstream network / connection errors (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ECONNRESET`)
  - DNS resolution failures (`DnsLookupError`, `ENOTFOUND`)
  - TLS handshake failures (`UPSTREAM_TLS_ERROR`, certificate validation errors)
  - HTTP 5xx status codes (500, 502, 503, 504) returned by the upstream origin
- **NOT Counted as Origin Failures (Neutral / Ignored)**:
  - Client aborts (`CLIENT_ABORTED`, client disconnect before proxy finishes writing)
  - Client 4xx status codes (400, 401, 403, 404, etc. indicate client/application state, not upstream server failure)
  - HTTP 2xx and 3xx responses (treated as successes, resetting consecutive failure counters where appropriate)

#### 2. Availability Predicate Rule
The `PoolSelector` interface from Batch 11 exposes:
```ts
public isAvailable?: (originId: string) => boolean;
```
This interface remains strictly stable. In Batch 12, the proxy supplies a compound predicate that combines the circuit breaker and health states:
$$\text{isAvailable}(originId) = \text{circuitBreaker.allowRequest}(originId) \land \text{passiveHealth.isHealthy}(originId) \land \text{activeHealth.isHealthy}(originId)$$
- **Circuit Breaker Check**: If the breaker is `OPEN`, the origin is unavailable (returns `false` immediately with zero upstream attempts). In `HALF_OPEN`, it permits only the configured number of concurrent trial requests. In `CLOSED`, requests pass through.
- **Passive Health Check**: If consecutive failures meet or exceed `consecutiveFailures` (default 3) within the sliding window, the origin is marked unhealthy. It remains unavailable until the cooldown period elapses.
- **Active Health Check**: If active probes are enabled, an origin is healthy until probe failures meet `unhealthyThreshold` (default 3), and requires `healthyThreshold` (default 2) consecutive successful probes to recover.
- **Failover Origins**: Primary origins are evaluated first; backup origins are engaged only when no healthy primary origin is available.

#### 3. Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `healthCheck.passive.enabled` | `boolean` | `true` | Enables passive failure detection on live proxy traffic. |
| `healthCheck.passive.consecutiveFailures` | `number` | `3` | Number of consecutive failures before marking an origin unhealthy. |
| `healthCheck.passive.failureWindowMs` | `number` | `30000` (30s) | Sliding window for counting failures; older failures age out. |
| `healthCheck.passive.cooldownMs` | `number` | `10000` (10s) | Cooldown duration before an unhealthy origin is allowed to re-enter service. |
| `healthCheck.active.enabled` | `boolean` | `false` | Enables proactive background health probing. |
| `healthCheck.active.intervalMs` | `number` | `10000` (10s) | Interval between consecutive active probes per origin. |
| `healthCheck.active.timeoutMs` | `number` | `2000` (2s) | Probe request timeout. |
| `healthCheck.active.path` | `string` | `"/healthz"` | Request path for active health probes. |
| `healthCheck.active.expectedStatus` | `number \| number[]` | `200` | HTTP status code(s) indicating probe success. |
| `healthCheck.active.healthyThreshold` | `number` | `2` | Consecutive successful probes required to mark an origin healthy. |
| `healthCheck.active.unhealthyThreshold`| `number` | `3` | Consecutive failed probes required to mark an origin unhealthy. |
| `circuitBreaker.enabled` | `boolean` | `true` | Enables per-origin circuit breaking. |
| `circuitBreaker.failureThreshold` | `number` | `5` | Consecutive failures before opening the circuit. |
| `circuitBreaker.openDurationMs` | `number` | `15000` (15s) | Time the circuit remains OPEN before transitioning to HALF-OPEN. |
| `circuitBreaker.halfOpenMaxRequests` | `number` | `1` | Max concurrent trial requests permitted in HALF-OPEN state. |
| `dnsCache.refreshAheadMs` | `number` | `5000` (5s) | Time before TTL expiration to trigger background DNS refresh. |
| `dnsCache.staleWhileResolvingMs` | `number` | `10000` (10s) | Maximum time to serve last-known DNS records if refresh fails. |

---

## 15. Compression & Content Negotiation (`compression`)

### Design & Architectural Principles

#### 1. Cache Storage Model & Compression Point
The proxy adopts **canonical uncompressed storage with streaming egress compression**:
- **Point of Compression**: Origin responses (if uncompressed) are cached in their canonical uncompressed representation. When serving a response (either from origin on a cache miss or from cache on a cache hit), the proxy dynamically streams the content through a `node:zlib` transform stream (`Gzip`, `Brotli`, or `Zstandard`) tailored to the specific client's negotiated `Accept-Encoding`.
- **Origin-Compressed Content**: If the origin returns an already-compressed body with `Content-Encoding: gzip`, it is preserved as-is. If an incoming client does not accept gzip (e.g. `Accept-Encoding: identity` or `Accept-Encoding: br`), the proxy decompresses the stream on-the-fly (subject to the decompression bomb limit) to serve the client's accepted format.
- **Reasons for Canonical Storage**:
  1. **Optimal Cache Utilization**: Single canonical representation per URL avoids multiplying cache footprint by 3-4x across encodings (`identity`, `gzip`, `br`, `zstd`).
  2. **Zero-Miss Cross-Encoding Hits**: A cache fill by a client requesting `Accept-Encoding: gzip` immediately enables cache hits for subsequent clients requesting `Accept-Encoding: br` or `identity` without any upstream fetch (1 upstream fetch total).
  3. **Exact Byte Accounting & Quotas**: Batch 9 byte accounting and Batch 10 tenant quotas track the exact canonical bytes of the single stored cache entry. No variant multiplier or quota skew occurs.
  4. **Bounded Memory**: Streaming through Node's native `zlib` transform streams processes chunks on the fly with bounded peak memory, even for large (10MB+) responses.

#### 2. Cache Key & Variant Representation
- **Vary Header**: Any cacheable response whose encoding is negotiated based on client request headers includes `Vary: Accept-Encoding` (even if identity is selected).
- **Normalized Accept-Encoding**: When computing cache keys or variant routing, `Accept-Encoding` header values are normalized into canonical sorted tokens (`br`, `gzip`, `identity`, `zstd`) after q-value filtering, so that permutations like `"gzip, br"` and `"br, gzip"` evaluate to identical negotiated decisions.
- **Client Isolation**: Client responses strictly receive the encoding negotiated for their connection. An encoding is never served to a client that refused it (`q=0`) or did not accept it.

#### 3. Validators (ETag) and Conditional Requests (RFC 9110)
- **ETag Transformation**: RFC 9110 Section 8.8.1 states that an intermediary altering an entity body (such as on-the-fly content coding) must ensure strong entity tags are not improperly preserved across distinct byte sequences. When the proxy compresses an origin body:
  - Strong ETags (e.g. `"xyz"`) are transformed into weak ETags prefixed with `W/` (e.g. `W/"xyz"`), or appended with an encoding differentiator (e.g. `W/"xyz-gzip"`).
  - Weak ETags (e.g. `W/"xyz"`) remain weak.
- **Conditional Requests (Batch 6/7)**: Under RFC 9110 Section 13.1.2, evaluation of `If-None-Match` uses weak comparison for cache validation. A client sending `If-None-Match: "xyz"` or `If-None-Match: W/"xyz"` correctly matches `W/"xyz"` and receives `304 Not Modified`.
- **304 Responses**: HTTP 304 responses contain no message body; compression bypass applies, and `304 Not Modified` is emitted immediately without `Content-Encoding`.

#### 4. Decompression Bomb Protection
To prevent zip-bomb / gzip-bomb denial of service attacks, any decompression stream (origin decompression) enforces a hard limit `maxDecompressedBytes` (default 100 MB). If the stream exceeds this limit, decompression is immediately aborted with `502 Bad Gateway` (error `DECOMPRESSION_BOMB_DETECTED`) without exhausting memory.

#### 5. Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `compression.enabled` | `boolean` | `true` | Enables proxy-side compression and content negotiation. |
| `compression.encodings` | `string[]` | `["zstd", "br", "gzip"]` | Supported compression codecs in order of proxy preference. |
| `compression.minBytes` | `number` | `1024` (1 KB) | Minimum response body length to qualify for compression. Below this, responses are served uncompressed. |
| `compression.maxDecompressedBytes` | `number` | `104857600` (100 MB) | Maximum decompressed bytes allowed before aborting as a decompression bomb. |
| `compression.levels.gzip` | `number` | `6` | Gzip compression level (valid: 1-9). |
| `compression.levels.brotli` | `number` | `4` | Brotli quality level (valid: 0-11). |
| `compression.levels.zstd` | `number` | `3` | Zstandard compression level (valid: 1-22). |
| `compression.contentTypes.allow` | `string[]` | `["text/*", "application/json", "application/javascript", "text/javascript", "application/xml", "text/xml", "image/svg+xml"]` | MIME types eligible for compression. |
| `compression.contentTypes.deny` | `string[]` | `["image/*", "video/*", "audio/*", "application/zip", "application/gzip", "font/woff2"]` | MIME types explicitly denied from compression. |
| `compression.bypass.header` | `string` | `"x-no-compression"` | Request header that explicitly bypasses compression when present. |
| `compression.debugHeader` | `string` | `"x-compression-bypass"` | Response header emitted when compression is bypassed detailing the reason. |

---

## 16. Range Requests, Partial Caching, Chunked Transfer & Binary Content (Batch 14)

### Design & Architectural Principles

#### 1. Range Requests (RFC 9110 §14.1.2 & §14.2)
- **Supported Syntaxes**:
  - Closed range: `bytes=0-499` (first 500 bytes)
  - Open-ended range: `bytes=500-` (from byte 500 to end of entity)
  - Suffix range: `bytes=-500` (final 500 bytes of entity)
- **Status & Headers**:
  - Valid range served from complete cached entity or origin returns `HTTP/206 Partial Content`.
  - Header `Content-Range: bytes <start>-<end>/<total>` emitted.
  - Header `Accept-Ranges: bytes` emitted on all responses containing full or partial content to advertise range support.
- **Unsatisfiable Ranges**:
  - If requested range begins at or beyond total entity size (e.g., `bytes=5000-6000` on a 1000-byte body), or suffix is 0, returns `HTTP/416 Range Not Satisfiable` with `Content-Range: bytes */<total>`.
- **If-Range Evaluation (RFC 9110 §13.1.5)**:
  - If client provides `If-Range` matching the entity's strong `ETag` or `Last-Modified` timestamp, the range request is fulfilled with `206 Partial Content`.
  - If the validator does not match (entity has changed), the entire updated representation is served with `HTTP/200 OK`.

#### 2. Partial Content Caching
- **Cache Sourcing**:
  - When the proxy holds a complete valid `200 OK` cached representation, incoming client `Range` requests are served directly from cache as `206 Partial Content` (Cache HIT) without querying upstream origin.
- **Origin 206 Handling**:
  - Incomplete 206 responses from the origin (e.g. upstream partial fetches) are passed through to the downstream client but are NOT cached as complete representations. Full objects are only stored when a complete `200 OK` body is received and verified.
- **Compression Interaction**:
  - Range requests over stored entities bypass dynamic egress re-compression or apply byte ranges to the exact transferred representation, ensuring byte ranges align with advertised `Content-Length`.

#### 3. Chunked Transfer Encoding
- **Hop-by-Hop Rules (RFC 9112 §7.1)**:
  - `Transfer-Encoding` is a hop-by-hop header. Upstream chunked responses are decoded on receive.
  - Responses stored in cache are saved as raw entity bytes with known length.
  - Downstream responses with known length use `Content-Length`. If streaming dynamically without predetermined length, `Transfer-Encoding: chunked` is used.
  - `Content-Length` and `Transfer-Encoding` are mutually exclusive; they are never emitted together.

#### 4. Content-Length Validation
- **Exact Byte Accounting & Smuggling Guard**:
  - When origin emits `Content-Length: N`, the proxy counts the exact payload bytes received.
  - **Underrun (Premature EOF)**: If stream closes with fewer than `N` bytes, the response is invalid/corrupt. It is aborted, dropped from cache (never stored partially), and downstream client receives a connection reset/error.
  - **Overrun**: If stream continues beyond `N` bytes, excess bytes are truncated or cause a `502 Bad Gateway` error to prevent HTTP smuggling.

#### 5. Binary Content Transparency
- **Binary Cleanliness**:
  - All stream pipelines, memory caches, and disk persistence mechanisms operate on raw Node.js `Buffer` and `Uint8Array` byte chunks.
  - No string conversions, charset decodings, or UTF-8 normalizations are applied to binary data.
  - Guaranteed bit-level round-trip equality (verified by SHA-256 hashes) for images, videos, audio, compressed archives, and arbitrary byte streams containing null bytes (`0x00`) and high-order bytes (`0x80 - 0xFF`).

---

## 17. TLS Configuration, Termination, Upstream TLS, Rotation & mTLS (Batch 15)

### Design Decisions & Security Posture

#### 1. Test-Only TLS Fixtures
- All test certificates, keys, and CA bundles located in `tests/fixtures/tls/` are **TEST-ONLY** and generated dynamically or via `scripts/gen-test-certs.sh`.
- `tests/fixtures/tls/README.md` explicitly declares that all fixtures are strictly for automated test suites and must never be used in production.
- Real private keys must never be committed to the repository.

#### 2. Minimum TLS Version & Cipher Suite Defaults
- **Minimum TLS Version**: `TLSv1.2` is enforced by default (`minVersion: 'TLSv1.2'`). Handshakes negotiating `TLSv1.0` or `TLSv1.1` are refused.
- **Cipher Defaults**: Modern, forward-secret AEAD cipher suites:
  - `ECDHE-ECDSA-AES128-GCM-SHA256`
  - `ECDHE-RSA-AES128-GCM-SHA256`
  - `ECDHE-ECDSA-AES256-GCM-SHA384`
  - `ECDHE-RSA-AES256-GCM-SHA384`
  - `ECDHE-ECDSA-CHACHA20-POLY1305`
  - `ECDHE-RSA-CHACHA20-POLY1305`
- Legacy ciphers without forward secrecy, 3DES, RC4, and CBC-mode ciphers without AEAD are excluded.

#### 3. Strict Certificate Verification by Default
- Certificate verification is **ON by default** for all upstream HTTPS connections (`rejectUnauthorized: true`).
- Verification can be disabled **only** by setting an explicit, loud config flag (`rejectUnauthorized: false` or `insecureSkipVerify: true`).
- When disabled, the proxy emits a loud security warning to `console.warn`:
  `[WARN] TLS certificate verification is explicitly DISABLED for upstream origin. This is insecure and vulnerable to MITM attacks.`

#### 4. Certificate Configuration & Validation (Feature 81)
- Valid certificates load from PEM format (cert and key paths).
- Validation at startup / load time:
  - Missing file: fails with clear descriptive error (without leaking private key contents).
  - Unreadable file (permissions): fails with clear error.
  - Malformed PEM: fails with parse error.
  - Key mismatch: validates public key in certificate matches private key using `crypto.createPublicKey` / `crypto.createPrivateKey` modulus/fingerprint match.
  - Expired certificate: rejects certificates whose `notAfter` is in the past.
- Supports multiple certificates using SNI (Server Name Indication) matching subject Alternative Names (SAN) or CN. An unknown SNI falls back to the configured default certificate.

#### 5. TLS Termination (Feature 79)
- HTTPS listener serves cached and proxied traffic end-to-end over TLS.
- Supports HTTP/1.1 keep-alive over TLS.
- Resilient to handshake aborts, malformed client hellos, and garbage bytes without leaking sockets or crashing the listener process.
- Compatible with all Batch 1–14 cache semantics.

#### 6. Upstream TLS (Feature 80)
- Connects to HTTPS origins with optional custom CA bundle (`ca` path).
- Rejects untrusted CA, expired origin certs, and hostname mismatches with a defined `502 Bad Gateway` error (`UPSTREAM_TLS_ERROR`).
- Upstream SNI is automatically set to the origin's target hostname.
- Connection pooling (Batch 11 `UpstreamPool`) pools TLS connections per target origin.
- Passive/active health checks and circuit breaker (Batch 12) track upstream TLS failures.

#### 7. Dynamic Certificate Rotation (Feature 82)
- Watches certificate and key files on disk without requiring proxy restart.
- In-flight requests continue uninterrupted on existing TLS connections.
- New connections immediately pick up the updated certificate.
- If a replacement file on disk is malformed, invalid, or mismatched, the proxy keeps the existing valid certificate active and loudly logs the error.
- All file watchers and rotation timers are cleanly stopped on proxy shutdown.

#### 8. Mutual TLS / Client Certificates (Feature 83)
- Listener supports client certificate authentication modes:
  - `off`: No client certificates requested.
  - `optional`: Client cert requested; if provided, verified against CA bundle.
  - `required`: Handshake fails if client certificate is missing or invalid.
- Verified client identity (Subject, SAN, SHA-256 fingerprint) is extracted and attached to the request context (`RequestContext.clientCert`).
- Upstream mTLS: Proxy presents configured client certificate and private key when connecting to mTLS-enabled origins.
- Private keys never appear in logs, error messages, or response headers.

---

## 14. Security, Access Control, and Authentication Architecture (Batch 16)

### 1. Order of Checks Per Request
Every incoming request is processed through an invariant, deterministic pipeline of security checks before any upstream call or cache read is performed:

```
[Incoming Request]
       │
       ▼
1. Client IP Trust & Resolution
       │   (Right-to-left X-Forwarded-For walk from trusted proxy peers only)
       ▼
2. Host Allowlist Verification
       │   (Host / :authority normalization, absolute-form URI match, 421/404 on unallowed)
       ▼
3. IP Allow / Deny Evaluation
       │   (IPv4/IPv6 CIDR matching; DENYLIST always takes precedence over ALLOWLIST -> 403)
       ▼
4. Authentication (API-Key / JWT / mTLS)
       │   (Header-only, constant-time hashed comparison, node:crypto verification,
       │    alg-confusion and alg=none rejection -> 401/403, never cached)
       ▼
5. Tenant Resolution & Context Attachment
       │   (Resolved from auth context, hostname, or path; sets tenant boundary)
       ▼
6. Request Header Filtering
       │   (Hop-by-hop stripped, connection-listed tokens stripped, internal headers stripped/overwritten,
       │    CR/LF header injection rejection)
       ▼
7. Cache Evaluation & RFC 9111 Shared-Cache Rules
       │   (Tenant-namespaced cache key; Authorization header stored only if response explicitly allows;
       │    Cache-Control: private NEVER stored)
       ▼
8. Origin Access Control (SSRF Guard)
       │   (Tenant origin permissions, loopback/private/link-local/cloud-metadata blocking,
       │    DNS rebinding defense, origin redirect safety)
       ▼
[Upstream Fetch]
       │
       ▼
9. Response Header Filtering
       │   (Hop-by-hop stripped, internal debug/tenant headers stripped,
       │    Set-Cookie policy, Server / Via headers added)
       ▼
[Downstream Client Response]
```

### 2. Cache Rules for Authenticated Requests (RFC 9111 Shared-Cache Rules)
- **RFC 9111 Section 3.5 Compliance**: A shared cache (CDN proxy) **must not store** a response to a request with an `Authorization` header field, unless the response explicitly allows it through one of the following `Cache-Control` directives:
  - `must-revalidate`
  - `public`
  - `s-maxage`
- **Private Responses**: A response containing `Cache-Control: private` is **never stored** in the shared cache under any circumstances.
- **Vary Headers**: If an authenticated response allows shared caching, the `Vary` header (such as `Vary: Accept-Encoding`) is strictly respected.
- **Auth Decisions**: Authentication results (401, 403) and permission decisions are **never cached**.

### 3. Tenant Namespace and Cache Key Isolation (Batch 10 Integration)
- Every cache entry key is prefixed by the tenant ID: `${tenantId}:${cacheKey}`.
- All eviction policies (LRU, LFU, FIFO, TTL), storage quotas, in-memory lookup, and disk persistence are scoped strictly to the tenant.
- **Cross-tenant Negative Guarantee**:
  - Tenant A can never read, inspect, hit, or revalidate Tenant B's cached entries.
  - Tenant A's operations cannot trigger eviction or quota exhaustion for Tenant B.
  - Authenticated responses for Tenant A are never served to Tenant B, even for identical request URLs.

### 4. JWT / OIDC Verification using `node:crypto`
- Verification of JWT tokens is performed entirely with Node.js built-in `node:crypto`. No external JWT library is used.
- **Algorithm Support**:
  - `HS256`: HMAC with SHA-256 (`crypto.createHmac`), compared using constant-time `crypto.timingSafeEqual`.
  - `RS256`: RSA signature verification (`crypto.verify` with `'RSA-SHA256'`).
  - `ES256`: ECDSA signature verification (`crypto.verify` with `'SHA256'`).
- **Algorithm Confusion Prevention**:
  - If a token specifies `alg: "none"`, it is unconditionally rejected with 401.
  - If an asymmetric key (RS256/ES256) is configured, tokens signed with symmetric algorithms (`HS256`) are rejected, preventing key-confusion attacks where a public key is used as an HMAC secret.
- **Claim Validation**:
  - Expiration (`exp`) and Not-Before (`nbf`) validated against current clock with configurable clock-skew tolerance (default 60s).
  - Issuer (`iss`) and Audience (`aud`) matched against configured expected values.
- **JWKS Key Rotation**:
  - Local or injected JWKS key store with `kid` lookup and TTL caching based on injected clock.

---

## 15. Observability, Logging, Metrics & Tracing (Batch 17: Features 92–99)

### 1. Architectural Design Decisions
- **Zero External SDKs**:
  - No `prom-client` library. The Prometheus text exposition format (version 0.0.4) is generated with native formatting, strict `# HELP` and `# TYPE` annotations, and compliant label escaping (`\` -> `\\`, `"` -> `\"`, `\n` -> `\n`).
  - No `@opentelemetry/*` SDKs. W3C Trace Context (`traceparent`, `tracestate`) generation, parsing, span propagation, context nesting, and sampling are implemented with native `node:crypto` and standard interfaces.
  - In-memory `SpanExporter` interface for unit and integration testing. Lightweight OTLP/HTTP JSON exporter for local collector tests, with constraints documented in `docs/KNOWN_GAPS.md`.

### 2. Metric Classification & Label Policy
- **Cache Hit / Miss Categorization**:
  | Request Scenario | `cdn_cache_hits_total` | `cdn_cache_misses_total` | Hit Ratio Numerator | Hit Ratio Denominator | Byte Hit Category |
  |---|---|---|---|---|---|
  | **Fresh Cache Hit** | `+1 (status="fresh")` | `0` | `+1` | `+1` | Served from cache |
  | **Stale Hit (SWR / SIE)** | `+1 (status="stale")` | `0` | `+1` | `+1` | Served from cache |
  | **Coalesced Follower** | `+1 (status="coalesced")`| `0` | `+1` | `+1` | Served from cache |
  | **Cache Miss (Origin 200)** | `0` | `+1 (reason="miss")` | `0` | `+1` | Served from origin |
  | **304 Revalidated (Origin 304)**| `0` | `+1 (reason="revalidated_304")`| `0` | `+1` | Body served from cache |
  | **Cache Bypass (Auth/No-Cache)**| `0` | `+1 (reason="bypass")` | `0` | `+1` | Served from origin |

- **Hit-Ratio Formulation**:
  - `cdn_cache_hit_ratio` = `total_hits / (total_hits + total_misses)`.
  - **Zero Denominator Rule**: When `total_hits + total_misses === 0`, `hit_ratio` returns `0.0` (never `NaN` or `Infinity`).

- **Byte-Hit Metrics**:
  - `cdn_cache_bytes_served_total{source="cache"}`: Counts bytes delivered to the client from cache (including 206 Range slices, compressed payloads, and cached bodies served on 304 origin revalidations).
  - `cdn_cache_bytes_served_total{source="origin"}`: Counts bytes delivered to the client directly from origin responses.
  - `cdn_cache_byte_hit_ratio` = `bytes_cache / (bytes_cache + bytes_origin)`. Returns `0.0` if denominator is `0`.

- **Strict Label Cardinality Policy**:
  - **Forbidden as Labels**: Raw URLs, query parameters, full paths, cache keys, request IDs, and client IP addresses are **never** permitted as Prometheus metric labels.
  - **Permitted Bounded Labels**:
    - `status`: `"fresh" | "stale" | "coalesced"`
    - `reason`: `"miss" | "bypass" | "revalidated_304" | "expired"`
    - `method`: Normalized HTTP verb (`"GET" | "HEAD" | "POST"`)
    - `status_code`: Normalized HTTP status (`"200" | "304" | "404" | "500"`)
    - `tenant`: Bounded tenant identifier (truncated to 64 chars; max 100 configured tenants, fallback to `"other"` for unbounded tenant values).

### 3. Structured Logging & Request Logs (Features 94 & 95)
- **JSON Lines Format (`ndjson`)**: One complete JSON line per request emitted on completion or termination.
- **Stable Field Schema**:
  ```json
  {
    "timestamp": "2026-10-23T18:00:00.000Z",
    "level": "info",
    "requestId": "uuid",
    "method": "GET",
    "path": "/api/resource",
    "statusCode": 200,
    "durationMs": 14.2,
    "cache": "HIT",
    "bytesSent": 1024,
    "tenant": "tenant-alpha"
  }
  ```
- **Sensitive Data Redaction**:
  - `Authorization` header redacted (`[REDACTED]`).
  - `Cookie` / `Set-Cookie` headers redacted (`[REDACTED]`).
  - API keys (`x-api-key`) redacted (`[REDACTED]`).
  - Sensitive query parameters (`token`, `key`, `api_key`, `secret`, `auth`, `password`) redacted in logged path: e.g. `/path?token=[REDACTED]`.
- **Non-blocking Execution**: Log emissions must never block or crash the request path. An in-memory queue with bounded capacity drops or samples under floods and logs a drop counter (`log_dropped_count`).
- **Single Line Guarantee**: Exactly one request log line emitted per request, including client aborts, socket resets, and proxy errors.

### 4. OpenTelemetry Tracing & Span Model (Feature 93)
- **W3C Trace Context**:
  - Incoming `traceparent` parsed (`version`, `traceId`, `parentId`, `flags`).
  - Valid `traceparent` continued: proxy creates child span with `parent_id` set to incoming span ID.
  - Invalid `traceparent` discarded and fresh trace ID initialized.
  - Outgoing upstream request carries updated child `traceparent` and propagates `tracestate`.
- **Span Hierarchy**:
  - Root Span: `cdn.request`
  - Child Spans:
    - `cache.lookup` (records cache hit/miss/stale/bypass decision)
    - `origin.fetch` (records upstream connect, TTFB, and completion)
    - `cache.revalidate` (records revalidation cycle)
- **Span Lifecycle**: Spans end exactly once on success, upstream error, or client cancellation.
- **Sampling**: Configurable sampler (`always_on`, `always_off`, `ratio`).
- **No Leaks**: Spans and attributes never contain auth headers, tokens, cookies, or secrets.

### 5. Prometheus /metrics Endpoint (Feature 92)
- Exposes Prometheus text format metrics at `/metrics`.
- Protected by Batch 16 authentication (API-key, IP allowlist, JWT) when configured.
- Scraping `/metrics` does not touch cache store, does not increment cache counters, and does not pollute request logs.

---

## 16. Advanced Metrics & Diagnostics (Batch 18: Features 100–104)

### 1. Architectural Design Decisions
- **Native Prometheus Histograms**:
  - Implements standard cumulative bucket histograms (`_bucket{le="..."}`, `_sum`, `_count`) without external dependencies.
  - Bounded default latency buckets aligned with standard HTTP SLO thresholds:
    - Origin Latency: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
    - Proxy Latency: `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]` seconds.
- **Cardinally-Fenced Multi-Dimensional Counters**:
  - `cdn_cache_evictions_total`: Bounded `reason` labels (`"lru" | "lfu" | "slru" | "ttl" | "size" | "quota"`) and sanitized `tenant` labels.
  - `cdn_cache_evicted_bytes_total`: Byte tracking counterpart for capacity reclaim accounting.
  - `cdn_cache_revalidations_total`: Bounded `result` labels (`"304_not_modified" | "200_updated" | "failed" | "stale_fallback"`) and `type` labels (`"sync" | "swr" | "background"`).
  - `cdn_upstream_errors_total`: Bounded `error_type` labels (`"connect_timeout" | "read_timeout" | "connection_refused" | "5xx" | "dns_failure" | "tls_error" | "aborted" | "other"`) and bounded `origin` labels.

### 2. Origin Latency Metric (Feature 100)
- Metric: `cdn_origin_latency_seconds` (histogram).
- Measures round-trip duration from initial dispatch to upstream origin until the origin response headers and body are received.
- Recorded only for requests that touch origin (cache misses, bypasses, conditional 304 revalidations, background revalidations).

### 3. Proxy Latency Metric (Feature 101)
- Metric: `cdn_proxy_latency_seconds` (histogram).
- Measures end-to-end proxy processing latency from client request arrival to response stream completion or client abort.
- Segmented by bounded `cache_status` (`"HIT" | "MISS" | "STALE" | "BYPASS"`).

### 4. Eviction Metrics (Feature 102)
- Metrics:
  - `cdn_cache_evictions_total`: Total entries evicted.
  - `cdn_cache_evicted_bytes_total`: Total payload bytes reclaimed through eviction.
- Hooks into:
  - Size-based and entry-based eviction policies (LRU, LFU, SLRU).
  - Background and inline TTL expired entry sweeps.
  - Per-tenant quota enforcement sweeps.

### 5. Revalidation Metrics (Feature 103)
- Metric: `cdn_cache_revalidations_total`.
- Differentiates:
  - Synchronous inline revalidations (client awaiting origin conditional response).
  - Asynchronous background stale-while-revalidate (SWR) revalidations.
- Classifies outcomes:
  - `304_not_modified`: Origin validated cached representation, freshened TTL.
  - `200_updated`: Origin sent new payload, replaced cached entry.
  - `failed`: Origin returned 5xx or network error, entry marked stale or retained under stale-if-error.
  - `stale_fallback`: Revalidation failed but stale response was delivered to client per RFC 5861.

### 6. Upstream Errors Metric (Feature 104)
- Metric: `cdn_upstream_errors_total`.
- Classifies origin failures:
  - `connect_timeout`: Origin TCP / TLS handshake timeout.
  - `read_timeout`: Origin first byte / TTFB timeout.
  - `connection_refused`: Socket `ECONNREFUSED`.
  - `5xx`: Origin returned 500, 502, 503, or 504.
  - `dns_failure`: DNS lookup failure / ENOTFOUND.
  - `tls_error`: TLS certificate rejection or protocol handshake failure.
  - `aborted`: Client canceled before origin completed.
