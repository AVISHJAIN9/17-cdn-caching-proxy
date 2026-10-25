# Known Gaps, Limitations, and Unverified Paths

This document tracks every `PARTIAL`, `UNVERIFIED`, and documented known limitation across all implementation batches. It is maintained and updated at the completion of each batch.

---

## 1. Response Trailers Forwarding
- **Feature**: Response forwarding (Feature 9)
- **Status / Limitation**: Known limitation (trailers dropped)
- **What is missing**: Forwarding of HTTP/1.1 chunked response trailers to the client.
- **Why**: RFC 9110 chunked trailer parsing and client stream framing was deferred to maintain simplicity in streaming pipelines in Batch 2.
- **What would verify it**: A real origin sending chunked transfer with trailing headers (e.g. `Trailer: Server-Timing`, followed by trailer fields after the final 0-length chunk), asserting the client receives those trailer headers.

---

## 2. Response Header Filtering
- **Feature**: Response header security filtering (Feature 91 / 150)
- **Status / Limitation**: Not yet implemented / Out of scope for Batches 1–2
- **What is missing**: Security filtering of response headers (e.g., stripping internal debug headers, enforcing CORS or CSP policies, removing sensitive server identity headers).
- **Why**: Explicitly designated as a security batch feature.
- **What would verify it**: Automated unit and integration tests asserting that configured restricted response headers from upstream are stripped prior to forwarding to downstream clients.

---

## 3. Advanced Upstream TLS (Custom CAs & mTLS) (Resolved in Batch 15)
- **Feature**: Upstream connections (Feature 7 / 80 / 83)
- **Status / Limitation**: Fully resolved in Batch 15
- **Resolution**:
  - Implemented upstream HTTPS with custom CA bundles, SNI hostname propagation, connection pooling/reuse, and health breaker integration.
  - Implemented client certificate authentication (mTLS) with required, optional, and off modes, exposing verified client identities (subject, SAN, fingerprint) on request context for downstream auth batches.
  - Implemented upstream mTLS client certificate presentation and zero-downtime rotation.
  - Verified via `tests/tls-upstream.test.ts` and `tests/mtls.test.ts`.

---

## 4. Upstream Connect Timeout on Non-Routable IP (RFC 5737)
- **Feature**: Timeouts (Feature 12)
- **Status / Limitation**: Partially environment-dependent
- **What is missing**: Complete isolation of the connect timeout on environments where the kernel immediately rejects 192.0.2.1 with "network unreachable" (EHOSTUNREACH / ENETUNREACH) returning 502 instead of hanging until timeout (504).
- **Why**: Operating system networking stacks vary: some drop SYN packets and wait for TCP timeout, while others immediately return ICMP Destination Unreachable. Both paths are handled safely (504 on timeout, 502 on unreachable).
- **What would verify it**: Running behind a packet filtering firewall (`pf` on macOS or `iptables -j DROP` on Linux) that silently drops SYN packets destined for the test IP, guaranteeing a TCP connection hang.

---

## 5. HTTP/2 and HTTP/3 Support
- **Feature**: Protocol support
- **Status / Limitation**: Known architectural limitation (Out of scope)
- **What is missing**: HTTP/2 (RFC 9113) and HTTP/3 (RFC 9114 / QUIC) transport protocols on both client listener and upstream connections.
- **Why**: The proxy core is intentionally implemented for HTTP/1.1 and HTTP/1.0. The specification states: "Do NOT implement HTTP/2 or HTTP/3. Say so in KNOWN_GAPS.md."
- **What would verify it**: TLS ALPN negotiation with `h2` or `h3`, binary framing parsers, multiplexed stream listeners, and end-to-end multi-stream test suites.

---

## 6. Multiple Origins Routing (Resolved in Batch 11)
- **Feature**: Multiple origins (Feature 54)
- **Status / Limitation**: Fully resolved in Batch 11
- **Resolution**:
  - Implemented declarative request routing across multiple origins via `originRoutes` (`pathPrefix`, `pathPattern`, `host`, `header`).
  - Implemented origin pools (`originPools`), member weighting (`weight`), and load balancing policies (`round-robin`, `least-connections`, `weighted`).
  - Verified via `tests/multiple-origins.test.ts`, `tests/origin-pools.test.ts`, `tests/weighted-routing.test.ts`, and `tests/load-balancing.test.ts`.

---

## 7. Content-Length Body Validation
- **Feature**: Content-length validation (Feature 89)
- **Status / Limitation**: Not implemented / Out of scope for Batch 3
- **What is missing**: Verifying that the actual body byte count transferred over the wire strictly matches the numeric value in the `Content-Length` header, and treating discrepancies (premature close or overflow) as invalid responses.
- **Why**: Batch 3 Feature 2 ("Response parsing") was explicitly scoped to structural header and status parsing: "Parse ONLY structure here... and do NOT validate that bytes actually delivered match Content-Length (that is the separate 'Content-length validation' feature; do not mark it done)."
- **What would verify it**: End-to-end tests where an upstream origin sends `Content-Length: 100` but sends only 40 bytes or 150 bytes, asserting that the proxy detects the mismatch and terminates the transfer.

---

## 8. RFC 9111 Freshness Calculation Scope & Known Limitations (Batches 5 & 6)
- **Feature**: RFC 9111 Freshness & Cache-Control (Features 19, 21, 24, 25, 45, 46, 47)
- **Status / Limitation**: Fully compliant with RFC 9111 §4.2.3 freshness lifetimes, Age calculation, and Date header handling:
  1. **Conservative Qualified Directive Handling**: Directives with field lists such as `no-cache="Set-Cookie"` or `private="X-Custom"` are parsed into `noCacheFields` and `privateFields`, but acted upon conservatively: qualified `no-cache` is treated as unqualified `no-cache`, and qualified `private` is treated as unqualified `private` (neither is stored).
  2. **Ignored Request Cache-Control Directives**: Request Cache-Control directives `min-fresh`, `max-stale`, `only-if-cached`, and non-zero `max-age` are fully parsed by the scanner but ignored during lookup. Only request `no-cache`, `no-store`, and `max-age=0` act as cache bypass triggers.
  3. **Heuristic Freshness (Implemented in Batch 6)**: RFC 9111 §4.2.2 heuristic freshness support piece is implemented based on `Last-Modified`. Configured via `cache.heuristic.{enabled, ratio, maxMs}`. It applies ONLY when no `s-maxage`, `max-age`, or `Expires` is present, response is cacheable (not `no-store`/`private`/`no-cache`), and `lastModifiedMs <= dateValueMs`.
  4. **Date Header Implementation (Fully Verified in Batch 6)**: Verified behavior: when the origin sends no Date header, or an invalid Date header, or multiple Date headers, the proxy synthesizes a valid IMF-fixdate `Date` header at `responseTime` from the Clock, sets `entry.dateSource = 'proxy_added'`, sets `dateValueMs = responseTimeMs`, and logs `date_missing` or `date_invalid`. On HIT, the stored Date is replayed unchanged (and does not drift as time advances). Proxy-generated responses (error, OPTIONS *, 304, etc.) set Date = now from Clock, with Node automatic Date suppressed (`res.sendDate = false`). All Batch 5 UNVERIFIED labels are resolved and removed.
  5. **Age Header Pass-through on MISS**: On cache MISS responses being forwarded to the client, any origin `Age` header is passed through unchanged (accurately describing upstream caches). The proxy does not add or alter the `Age` header on MISS responses.
  6. **Stale Serving & Revalidation**: Stale entries are NEVER served under any condition. Stale entries are lazily deleted at lookup and reported as miss reason `"expired"`. Therefore, `must-revalidate`, `proxy-revalidate`, `stale-while-revalidate`, and `stale-if-error` are trivially satisfied because stale entries are never served.
  7. **S-maxage Precedence**: Freshness lifetime calculation implements `s-maxage` > `max-age` > `Expires` > `heuristic` > `none` precedence as required for RFC 9111 shared caches; however, the separate "S-maxage" feature remains PARTIAL pending revalidation and surrogate control integration.
- **What would verify it**: Future batch tests for revalidation (304), heuristic freshness (Batch 6 Last-Modified), and request freshness controls (`min-fresh`/`max-stale`).

---

## 9. Cache Eviction & Storage Subsystem (Resolved in Batch 9)
- **Feature**: Memory cache eviction & storage (Features 27, 30, 31, 32, 33, 34, 35)
- **Status / Limitation**: Fully resolved in Batch 9
- **Resolution**:
  1. **Memory Cache (Feature 27)**: Decoupled in-memory storage behind `ICacheStore` interface wired directly into proxy lookup, hit, miss, fill, and eviction paths.
  2. **Metadata Index (Feature 30)**: $O(1)$ key-to-metadata index storing size, status, headers, storedAt, lastAccessedAt, hitCount, and namespace; updates on hit; deletes cleanly without orphans.
  3. **Object Storage (Feature 31)**: Byte-accurate body storage decoupled from metadata. Streaming reads are thread-safe and immune to concurrent eviction/replacement.
  4. **LRU Eviction (Feature 32)**: Pluggable eviction policy evicting least recently accessed entries first, updating access order on hit and lookup.
  5. **LFU Eviction (Feature 33)**: Pluggable eviction policy evicting lowest frequency entries first, with deterministic tie-breaking (oldest last-access, then keyHash).
  6. **TTL Eviction (Feature 34)**: Identifies and evicts expired entries past all stale windows. Entries inside `stale-while-revalidate` or `stale-if-error` windows are protected from TTL eviction.
  7. **Size Eviction (Feature 35)**: Strictly enforces `maxTotalBytes` and `maxEntries` budgets via active eviction policy. Rejects oversized objects without partial state. Protects entries under active revalidation locks and in-flight coalescing.
- **Verification**: Verified via `tests/memory-cache.test.ts`, `tests/metadata-index.test.ts`, `tests/object-storage.test.ts`, `tests/eviction-lru.test.ts`, `tests/eviction-lfu.test.ts`, `tests/eviction-ttl.test.ts`, and `tests/eviction-size.test.ts`.

---

## 9b. Disk Cache and Persistence Not Implemented (Batch 9 Out-of-Scope)
- **Feature**: Disk cache (Feature 28) and Persistent cache (Feature 29)
- **Status / Limitation**: Explicitly not implemented / Out of scope for Batch 9
- **What is missing**: Filesystem/block-backed disk caching, memory-to-disk tiering, and persistent cache survival across proxy process restarts. Also out of scope: segmented cache (Feature 36), namespace management (Feature 37), tenant quotas (Feature 38), and per-tenant object limits (Feature 39).
- **Why**: Batch 9 explicitly confines storage and eviction to the in-memory store architecture. The storage interface (`ICacheStore`, `MetadataIndex`, `ObjectStore`) is intentionally decoupled to allow pluggable disk and persistent backends in future batches.
- **What would verify it**: Future batch test suites using persistent disk-backed stores, crash-recovery tests, and cross-restart cache hit verification.

---

## 10. Vary Header Handling
- **Feature**: Vary header support (Feature 94)
- **Status / Limitation**: Responses with `Vary` are bypassed and not stored
- **What is missing**: Storing and selecting secondary cache variants based on request headers specified in the origin's `Vary` response header (e.g., `Vary: Accept-Encoding, Accept-Language`).
- **Why**: Storing responses that carry `Vary` headers without full secondary variant indexing risks serving the wrong variant to subsequent clients with different capabilities.
- **What would verify it**: Multi-variant integration tests verifying that distinct `Accept-Encoding` variants (e.g. gzip vs br vs identity) are stored and matched independently.

---

## 11. Request Coalescing / Stampede Prevention (Resolved in Batch 8)
- **Feature**: Request coalescing / Stampede prevention (Features 50 & 51)
- **Status / Limitation**: Fully resolved in Batch 8
- **Resolution**:
  1. **Cold-Miss Request Coalescing (Feature 50)**: Multiple concurrent misses for the identical cache key collapse into exactly 1 in-flight upstream request. Followers await leader completion and are served directly from cache store upon leader fill.
  2. **Stampede Prevention on Expiry (Feature 51)**: 50 concurrent requests on an expired entry collapse into exactly 1 upstream conditional revalidation request (reducing upstream requests from 50 down to 1).
  3. **Replacement Delivery**: On 200 replacement during revalidation, the leader streams and writes the new body into cache store before resolving followers, ensuring all waiting clients receive the updated body.
  4. **Collapsed Forwarding Note (Feature 52)**: Collapsed forwarding of concurrent misses is structurally covered by Request Coalescing (Feature 50). Feature 52 is not marked DONE pending explicit routing and backend scope definitions.
- **Verification**: Verified via `tests/coalescing.test.ts` (5 concurrency tests) and `tests/stampede.test.ts` (6 concurrency tests, tested up to 100 parallel requests).


---

## 12. Age and Date Headers on Cache Hit
- **Feature**: Age header / Date header generation (Features 46 & 47, RFC 9111 §5.1 & §5.6.1)
- **Status / Limitation**: Fully implemented and verified in Batches 5 & 6
- **Implementation**: `Age` header calculation and injection implemented in Batch 5; `Date` header policy, IMF-fixdate formatting, origin Date validation, proxy-generated Date headers, and HIT replay implemented in Batch 6.
- **Verification**: Verified via `tests/age-header.test.ts` and `tests/date-header.test.ts`.

---

## 13. HEAD Method Bypass
- **Feature**: HTTP method caching (Feature 47)
- **Status / Limitation**: Temporary bypass for HEAD requests
- **What is missing**: Serving HEAD requests directly from existing cached GET responses without contacting origin, or caching HEAD responses.
- **Why**: Batch 4 scope fence specifies a conservative policy where only GET is cached, and HEAD bypasses cache lookup (`reason: method_not_cacheable`).
- **What would verify it**: A test verifying that a HEAD request for an entry primed via GET is served as a cache HIT with stored headers and an empty body.

---

## 14. Client Conditionals & Upstream Miss Limitation (Resolved in Batch 7)
- **Feature**: Client Conditional Requests (Features 20, 21, 22, 23, 40, 42, 43)
- **Status / Limitation**: Fully resolved in Batch 7
- **Resolution**:
  1. **200-to-Conditional Filling**: When a client conditional request (`If-None-Match` or `If-Modified-Since`) misses in cache and reaches the origin, an origin 200 response is now fully storable under normal rules (removing the Batch 6 `conditional_request_miss` skip reason). If origin answers 304 on a true miss, it passes through unstored with `origin_304_no_entry`.
  2. **Upstream 304 Processing & Freshness Recompute**: Origin 304 responses refresh stored headers and recompute freshness lifetimes per RFC 9111 §3.2.
  3. **Proactive Upstream Revalidation**: Stale entries with validators trigger synchronous conditional revalidation.
  4. **Bypass for Other Conditionals**: `If-Match`, `If-Unmodified-Since`, `If-Range`, and `Range` continue to bypass cache lookup (`reason: method_not_cacheable` or `conditional_request`). 412 Precondition Failed and 206 Partial Content are not generated.

---

## 15. Validator Processing Constraints & Edge Cases (Batch 6)
- **Feature**: Validators and Heuristic Freshness (Features 20, 21)
- **Status / Limitation**: Documented validator edge cases
- **Details**:
  1. **Multiple or Invalid Validators**: An origin response with multiple `ETag` or multiple `Last-Modified` headers, or an unparseable validator, is treated as having no usable validator (`entry.etag = undefined`, `entry.lastModifiedMs = undefined`), and logs `etag_multiple`, `etag_invalid`, or `last_modified_multiple`. The response is still storable if explicit freshness directives exist, and raw headers are replayed on HIT, but it cannot answer client conditional requests with 304 (always serves 200).
  2. **Last-Modified Later Than Date**: An origin response whose `Last-Modified` header is strictly after its `Date` header does not receive heuristic freshness (`lifetime = 0`, skipped with `reason: no_freshness_info`).
  3. **Unused `strongMatch`**: `strongMatch` is fully implemented and tested in `src/cache/etag.ts`, but unused in Batch 6 because RFC 9110 §13.1.2 mandates weak comparison for `If-None-Match`. Reserved for future range or `If-Match` features.
  4. **Obsolete Warning Header Not Implemented**: RFC 9111 §5.5 obsoleted the `Warning` header (e.g., `Warning: 113 - "Heuristic Expiration"`). The proxy does not generate or attach `Warning` headers to responses using heuristic freshness.

---

## 16. Batch 7 & 8 Revalidation Scope Fence, Gaps, and Baselines
- **Feature**: Revalidation & RFC 9111 Shared Cache Control (Features 40, 42, 43, 151, 152) and Stale Serving / SWR / SIE (Features 26, 41, 44, 49, 145)
- **Status / Limitation**: Documented constraints and resolutions:
  1. **Stampede Baseline on Stale Entries (Resolved in Batch 8)**: The Batch 7 baseline (50 concurrent requests on a single stale entry produce 50 origin requests) is fully resolved. Under Feature 51 (Stampede prevention), 50 concurrent stale requests collapse to exactly 1 upstream conditional revalidation.
  2. **Stale Serving Scope Fence (Resolved in Batch 8)**: Features 26 (`stale-while-revalidate`), 41 (`Background revalidation`), 44 (`Stale serving`), 49 (`Revalidation locks`), and 145 (`stale-if-error`) are implemented and verified. Stale serving is safely permitted within RFC 5861 windows, while `must-revalidate`, `proxy-revalidate`, and `s-maxage` strictly override and forbid stale delivery.
  3. **Validator Mismatch Response**: When an origin 304 returns an ETag that does not weak-match the stored entry, the proxy logs `validator_mismatch`, deletes the stale entry, and responds with `502 Bad Gateway` (`UPSTREAM_INVALID_RESPONSE`) without transparent retry. A future retry / unconditional revalidation feature may upgrade this path.
  4. **Always-Revalidate Entries Not Stored**: Responses with `no-cache`, `private`, `no-store`, `max-age=0`, or zero lifetime are not stored, even when they carry validators. Supporting always-revalidate entries (storing `no-cache` or `max-age=0` responses alongside an ETag to serve only via 304) is tracked as a future optimization.
  5. **Last-Modified Not Compared on 304 Refresh**: In `applyNotModified`, when an origin responds with 304, only `ETag` is checked for validator mismatch (using RFC 9111 weak comparison). `Last-Modified` is not compared for mismatch because HTTP date formatting variants, intermediary timestamp roundtrips, and 1-second resolution differences make date inequality unreliable as an indicator of representation corruption.
  6. **Cancelled Revalidations**: If a client aborts/disconnects during synchronous revalidation, the proxy aborts the in-flight upstream request, changes nothing in the cache store, and does not refresh the entry. Under request coalescing, a follower aborting does not cancel the leader request.
  7. **Request `Cache-Control: no-cache`**: An incoming client request with `Cache-Control: no-cache` (or `Pragma: no-cache`) bypasses the cache entirely and fetches fresh content from origin, rather than triggering a conditional revalidation against cached content.

---

## 17. Batch 10 Scope Fence, Out-of-Scope Items, and Architectural Boundaries

- **Feature**: Disk Cache, Persistence, Segmentation, Namespaces, Quotas & Limits (Features 28, 29, 36, 37, 38, 39)
- **Status / Limitation**: Documented constraints and explicit scope boundaries:
  1. **Purge APIs (Features 118–128) NOT Implemented**:
     - Explicit programmatic cache invalidation endpoints (URL purge, surrogate-key purge, tag purge, wildcard purge) are NOT implemented in Batch 10 and remain strictly out of scope. Deletion occurs solely through internal eviction (TTL, capacity, LRU/LFU/SLRU, and tenant quotas).
  2. **Compaction (Feature 146) NOT Implemented**:
     - Background storage compaction, defragmentation, and disk hole-punching are NOT implemented. Disk files are deleted via atomic `fs.unlinkSync()`.
  3. **Origin Validation (Feature 48) & Consistent Hashing (Feature 148) NOT Implemented**:
     - Upstream origin certificate validation and consistent hashing topologies remain out of scope for Batch 10.
  4. **Relationship between Request Coalescing (Feature 50) and Collapsed Forwarding (Feature 52)**:
     - Feature 50 (Request Coalescing, implemented in Batch 8) structurally accomplishes collapsed forwarding: concurrent requests for the same cold cache key coalesce into a single upstream request, and all followers are satisfied from the resulting cached representation.
     - However, per Batch 10 requirements, Feature 52 is NOT marked DONE in Batch 10 and remains reserved for its designated milestone.
  5. **Directory Scaling & Sharding**:
     - `DiskStore` stores objects in a flat directory (`<dirPath>/<hexKeyHash>.cache`). For deployments with tens of millions of entries, two-level directory sharding (e.g., `ab/cd/<hash>.cache`) to avoid filesystem directory entry bottlenecks is deferred to a future performance milestone.
  6. **Checksum Algorithm**:
     - File integrity uses SHA-256 (32 bytes in a 48-byte header). Hardware-accelerated CRC32c or xxHash is reserved for future high-throughput optimization.

---

## 18. Health Checks, Failover, Circuit Breaker & DNS Refresh (Resolved in Batch 12)

- **Feature**: Health Checks, Failover, Circuit Breaker, DNS Refresh (Features 57, 58, 59, 60, 61, 64)
- **Status / Limitation**: Fully resolved in Batch 12
- **Resolution**:
  1. **Passive Health Checks (Feature 60)**: Live request outcome tracking with sliding-window consecutive failure counting, 4xx/client abort exclusion, and automatic cooldown recovery.
  2. **Active Health Checks (Feature 59)**: Background periodic HTTP/HTTPS health probes with dual-threshold hysteresis (`healthyThreshold` / `unhealthyThreshold`), non-overlapping probe locks, and clean timer teardown.
  3. **Health Routing (Feature 57)**: Integrated compound availability predicate `isAvailable(originId)` into `PoolSelector` across round-robin, least-connections, and weighted load balancing policies, with graceful 502 fallback when all origins are unhealthy.
  4. **Failover Origins (Feature 58)**: Primary member prioritization with ordered backup failover, immediate recovery return, and invariant cache keys across failover.
  5. **Circuit Breaker (Feature 61)**: Per-origin tri-state circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`) with zero-upstream-attempt rejection in `OPEN` and trial request concurrency limiting in `HALF_OPEN`.
  6. **DNS Refresh (Feature 64)**: Proactive background DNS cache refreshment ahead of expiry without blocking requests, with bounded stale fallback on resolution failure and request coalescing.
- **Verification**: Verified via `tests/passive-health-checks.test.ts`, `tests/active-health-checks.test.ts`, `tests/health-routing.test.ts`, `tests/failover-origins.test.ts`, `tests/circuit-breaker.test.ts`, `tests/dns-refresh.test.ts`, and `tests/batch-12-cross-cutting.test.ts`.

---

## 20. Compression & Content Negotiation (Resolved in Batch 13)

- **Feature**: Compression and Content Negotiation (Features 66, 67, 68, 69, 70, 71, 72, 73)
- **Status / Limitation**: Fully resolved in Batch 13
- **Resolution**:
  1. **Accept-Encoding Parsing (Feature 70)**: Parses complex Accept-Encoding headers with quality values (q-values), tokens, `q=0` explicit refusal, wildcard `*`, `identity`, case-insensitivity, and bound on malformed input without crash.
  2. **Content Negotiation (Feature 69)**: Negotiates optimal encoding based on client q-values and deterministic proxy codec preference order (`zstd` > `br` > `gzip`). Emits `Vary: Accept-Encoding` on all negotiated and cacheable responses.
  3. **Gzip Streaming (Feature 66)**: Streaming compression and decompression using native `node:zlib` with backpressure and bounded memory on 10MB+ streams. ETag weakened (`W/`) per RFC 9110. Decompression bomb protection with configurable `maxDecompressedBytes`.
  4. **Brotli Streaming (Feature 67)**: Streaming Brotli compression and decompression using native `node:zlib.createBrotliCompress` / `createBrotliDecompress`.
  5. **Zstandard Streaming (Feature 68)**: Streaming Zstandard compression and decompression using native Node 22 `node:zlib.createZstdCompress` / `createZstdDecompress` with no third-party dependencies.
  6. **Compression Levels (Feature 72)**: Configurable per-codec levels (`gzip: 1-9`, `br: 0-11`, `zstd: 1-22`) with startup range validation and safe defaults (`gzip: 6`, `br: 4`, `zstd: 3`).
  7. **Content-Type Rules (Feature 73)**: Built-in compressible patterns (`text/*`, `application/json`, `*+json`, `*+xml`, `image/svg+xml`, `application/javascript`, `application/wasm`) and incompressible patterns (`image/*`, `video/*`, `audio/*`, `application/zip`, `font/woff2`). Configurable allow and deny list overrides with parameter stripping and case insensitivity.
  8. **Compression Bypass (Feature 71)**: Authoritative bypass checks for body size below threshold (`< minBytes`), `Cache-Control: no-transform`, origin already-encoded response, non-compressible content types, `Range` or `206 Partial Content`, HTTP 204/304, `HEAD` requests, and configured bypass headers/routes. Bypass reasons exposed via `X-Compression-Bypass` debug header.
- **Verification**: Verified via `tests/accept-encoding.test.ts`, `tests/content-negotiation.test.ts`, `tests/gzip.test.ts`, `tests/brotli.test.ts`, `tests/zstandard.test.ts`, `tests/compression-levels.test.ts`, `tests/content-type-rules.test.ts`, `tests/compression-bypass.test.ts`, and `tests/batch-13-cross-cutting.test.ts`.

---

## 22. Range Requests, Partial Caching & Payload Framing (Resolved in Batch 14)

- **Feature**: Range Requests, Partial Caching, Chunked Transfer, Content-Length Validation, Binary Content (Features 74, 75, 76, 77, 78)
- **Status / Limitation**: Fully resolved in Batch 14
- **Resolution**:
  1. **Range Requests (Feature 74)**:
     - RFC 9110 Section 14.1.2 single byte-range parser (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`) handling whitespace, multiple ranges (first range selection), and invalid/unsatisfiable syntax returning 416 Range Not Satisfiable with `Content-Range: bytes */total`.
     - RFC 9110 Section 13.1.2 `If-Range` conditional evaluation against ETag (strong match per RFC) and Last-Modified date (exact HTTP date match). On match, serves 206 Partial Content; on mismatch, serves 200 OK complete body.
  2. **Partial Caching (Feature 75)**:
     - Directly synthesizes and serves HTTP 206 Partial Content slices directly out of complete cached 200 OK objects in MemoryStore/DiskStore without contacting origin.
     - Sets exact `Content-Range: bytes start-end/total`, exact `Content-Length: slice.length`, and `Accept-Ranges: bytes`.
  3. **Chunked Transfer (Feature 76)**:
     - Clean streaming of origin chunked transfer-encoding responses (`Transfer-Encoding: chunked`) to downstream clients.
     - Strips hop-by-hop `Content-Length` header on chunked proxy responses per RFC 9112 Section 6.3.
     - Assembles and stores cacheable chunked origin responses into coherent cache entries served with exact `Content-Length` on subsequent cache hits.
  4. **Content-Length Validation (Feature 77)**:
     - Enforces exact byte counting on response bodies with `Content-Length`.
     - Premature EOF / Underrun drop: Discards partial responses on premature upstream connection close, does not store corrupted partial objects in cache, and aborts downstream socket.
     - Overrun smuggling guard: Detects excess bytes beyond declared `Content-Length`, immediately aborts stream and closes sockets to prevent HTTP request/response smuggling.
  5. **Binary Content (Feature 78)**:
     - Transparent, bit-identical preservation for arbitrary octet streams (`application/octet-stream`), binary media (`image/png`, `video/mp4`, `audio/mpeg`), embedded null bytes (`0x00`), and non-UTF-8 byte sequences (`0x80`–`0xFF`).
     - Preserves SHA-256 byte identity across origin, proxy streaming, cache storage, and cache hits.
- **Verification**: Verified via `tests/range-requests.test.ts`, `tests/partial-caching.test.ts`, `tests/chunked-transfer.test.ts`, `tests/content-length-validation.test.ts`, and `tests/binary-content.test.ts`.

---

## 23. Batch 14 Scope Fence, Out-of-Scope Items, and Architectural Boundaries

- **Feature**: Range Requests, Partial Caching & Payload Framing (Features 74, 75, 76, 77, 78)
- **Status / Limitation**: Documented constraints and explicit scope boundaries:
  1. **TLS Termination and Upstream TLS (Features 79–83) NOT Implemented**:
     - TLS termination, certificate configuration, certificate rotation, upstream TLS, and mTLS are strictly out of scope for Batch 14 and reserved for Batch 15.
  2. **Security, Auth & Filtering (Features 84–91, 150) NOT Implemented**:
     - API-key authentication, JWT/OIDC, origin access control, IP allow/denylists, and header filtering are reserved for Batch 16.
  3. **Metrics & Logging (Features 92–104) NOT Implemented**:
     - Prometheus exposition, OpenTelemetry traces, structured/request logging, and latency metrics are reserved for Batches 17 and 18.
  4. **Cache Purge APIs (Features 118–128) NOT Implemented**:
     - Programmatic cache invalidation (URL, tag, surrogate-key) is reserved for Batch 19.

---

## 24. OpenTelemetry OTLP Exporter Limits & Batch 17 Scope Boundaries

- **Feature**: OpenTelemetry (Feature 93) & Batch 17 Observability
- **Status / Limitation**: Documented architectural limits for native OTLP export:
  1. **Zero External SDKs Constraint**:
     - The proxy intentionally avoids heavy external dependencies (`@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`).
     - Tracing uses native W3C Trace Context formatting and an in-memory `SpanExporter`.
  2. **OTLP/HTTP JSON Limits**:
     - OTLP export is implemented via lightweight HTTP POST carrying OTLP JSON (`v1/traces`).
     - Protobuf encoding (gRPC / `application/x-protobuf`) is **not supported**; only JSON encoding is emitted.
     - Transport compression (e.g. gzip-compressed OTLP batches) is not enabled by default for export payloads.
     - Retries on network failure follow a simple single retry policy without persistent disk-spooled queues.
  3. **Batch 17 Out-of-Scope Items**:
     - Latency histograms (origin latency, proxy latency), revalidation counters, eviction counters, and upstream error classification are deferred to Batch 18.
     - Web UI Dashboard and cache overview visualization (Features 105, 106) are deferred to subsequent UI batches.

---

## 25. Advanced Metrics Resolution & Batch 18 Scope Boundaries

- **Feature**: Features 100–104 (Origin Latency, Proxy Latency, Eviction Metrics, Revalidation Metrics, Upstream Errors)
- **Status / Limitation**: Fully resolved in Batch 18 with native Prometheus histogram generation and multi-dimensional counters:
  1. **Histogram Bounds**:
     - Prometheus histograms use native fixed cumulative buckets. Exponential histograms or dynamic bucket allocation are not used to guarantee bounded memory.
  2. **Batch 18 Out-of-Scope Items**:
     - Web UI Dashboard and cache overview visualization (Features 105–117) are deferred to Batch 19 (Frontend / Operations).
     - Cache Purge APIs (Features 118–128) are deferred to Batch 20 (Purge & Control APIs).
