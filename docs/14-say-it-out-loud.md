# Master 'Say It Out Loud' Interview Rehearsal Scripts

This document gathers every first-person spoken script from the feature documentation so the developer can rehearse them aloud before interviews.

---

## Rehearsal Checklist

| Feature ID | Feature Name | Target Depth | Rehearsal Completed |
| :--- | :--- | :--- | :---: |
| **F1** | RFC 9111 Caching Core & Header Parsing | 15 - 20 lines | [ ] |
| **F2** | Single-Flight Request Coalescing | 15 - 20 lines | [ ] |
| **F3** | Multi-Tier Memory & Segmented Disk Storage | 12 - 15 lines | [ ] |
| **F4** | Eviction Algorithms (LRU, LFU, SLRU, TTL) | 10 - 12 lines | [ ] |
| **F5** | Conditional Revalidation & 304 Handling | 12 - 15 lines | [ ] |
| **F6** | Surrogate-Key Tag Purge & Audit Trail | 15 - 20 lines | [ ] |
| **F7** | Streaming Compression (Brotli, Gzip, Zstd) | 10 - 12 lines | [ ] |
| **F8** | RFC 7233 Byte-Range Requests & Slicing | 10 - 12 lines | [ ] |
| **F9** | Multi-Origin Routing & Circuit Breakers | 15 - 20 lines | [ ] |
| **F10** | Edge Security WAF, JWT & Dynamic TLS | 12 - 15 lines | [ ] |
| **F11** | Observability: Prometheus & OpenTelemetry | 10 - 12 lines | [ ] |
| **F12** | Admin Control Plane & Embedded SPA | 10 - 12 lines | [ ] |
| **F13** | Next.js 14 Real-Time Telemetry Dashboard | 12 - 15 lines | [ ] |
| **F14** | Ketama Consistent Hash Ring & Peer Mesh | 15 - 20 lines | [ ] |
| **F15** | Cache Pre-Warming & Link Header Prefetch | 8 - 10 lines | [ ] |
| **F16** | AIML Tier Models & Deterministic Fallbacks | 10 - 12 lines | [ ] |

---

## Spoken Scripts (In Order)

### F1: RFC 9111 Caching Core & Header Parsing
> "I built the RFC 9111 caching engine in `src/cache/lookup.ts` and `src/cache/serve.ts` to provide strict HTTP-compliant caching at sub-millisecond edge speeds. When a request arrives, the proxy normalizes the query parameters and headers into a canonical SHA-256 key and checks our memory store. On a cache hit, we evaluate the object's age and freshness lifetime, attach `X-Cache: HIT` and `Age` headers, and stream the cached buffer straight to the client socket without touching disk or origin. If the object has expired, we check for `stale-while-revalidate` directives; if present, we serve the stale content immediately to keep user latency under one millisecond while kicking off a background revalidation to origin. The main alternative was a naive memory dictionary, but implementing full RFC 9111 semantics ensures compliance with standard browser and CDN behaviors."

### F2: Single-Flight Request Coalescing (Thundering Herd)
> "I engineered request coalescing in `src/proxy/coalesce.ts` to protect origin web servers and databases from catastrophic thundering herd cache stampedes. When hundreds of concurrent requests miss the cache for the exact same resource simultaneously, dispatching all of them to the origin would saturate database connection pools and crash the backend. Instead, my `joinOrLead` algorithm designates the first arriving request as the leader and suspends the subsequent 499 requests in an in-memory waiter map. The leader issues a single upstream HTTP request. When the response stream arrives, we fan out the chunks to all 500 client sockets simultaneously and commit one copy into the cache. This reduced our upstream traffic during stampedes by 99.8% while keeping memory usage strictly bounded."

### F3: Multi-Tier Memory & Segmented Disk Storage
> "I designed a multi-tier storage engine in `src/cache/memory-store.ts` and `src/cache/disk-store.ts` that combines sub-millisecond RAM lookups with large-capacity persistent SSD caching. Small, frequently requested static assets are cached directly in Node.js Buffers inside `MemoryStore`, bounded by strict tenant quotas to prevent any single tenant from monopolizing the cache. For larger assets and persistent retention across proxy restarts, the proxy spills to `DiskStore`, storing data in segmented files with an in-memory metadata index. When disk space becomes fragmented after object updates and evictions, our background compaction worker reclaims dead bytes without interrupting active reads."

### F4: Eviction Algorithms (LRU, LFU, SLRU, TTL)
> "I implemented four distinct cache eviction algorithms in `src/cache/eviction/`—LRU, LFU, Segmented LRU, and TTL—so the proxy can adapt its memory eviction strategy to different traffic patterns. In default LRU mode, we maintain a doubly-linked list tracking item access recency in O(1) time. For workloads subject to one-hit-wonder scans that would flush popular items out of a naive LRU, I added Segmented LRU, which requires an item to be accessed twice before promoting it to the protected segment. When capacity thresholds are breached, the policy evicts low-priority entries and emits telemetry metrics to Prometheus to track eviction rates."

### F5: Conditional Revalidation & 304 Handling
> "I built the conditional revalidation engine in `src/cache/revalidate.ts` and `src/cache/refresh.ts` to minimize network bandwidth during cache refreshes. When a cached object reaches its TTL, we don't discard it immediately; instead, we send an upstream conditional request carrying the cached `ETag` in an `If-None-Match` header. If the origin returns a 304 Not Modified, we refresh the object's TTL and headers in-place without re-transmitting the response body, saving 99% of bandwidth. Similarly, when clients send conditional requests to the proxy, we validate their validators against our cached metadata and return a 304 directly from the edge."

### F6: Surrogate-Key Tag Purge & Cryptographic Audit
> "I developed the Surrogate-Key tag purge engine in `src/purge/` to enable instant, precise cache invalidation across thousands of related URLs. In e-commerce platforms, updating a single product requires invalidating category pages, search results, and promotional banners. By having origins attach `Surrogate-Key` or `Cache-Tag` headers, our proxy indexes every cache entry by its tags in an inverted index. When an invalidation API call arrives, we invalidate all matching entries in under five milliseconds. Every purge operation is cryptographically signed and appended to a SHA-256 tamper-evident audit trail, giving infrastructure teams full accountability and security compliance."

### F7: Streaming Compression (Brotli, Gzip, Zstandard)
> "I implemented on-the-fly streaming compression in `src/compression/codecs.ts` supporting Brotli, Gzip, and Zstandard. When an upstream origin returns uncompressed text, HTML, or JSON, our proxy inspects the client's `Accept-Encoding` header, selects the highest-efficiency algorithm, and pipes the response through a native compression transform stream. To prevent malicious decompression bomb attacks from exhausting server memory, I added a custom `DecompressionBombLimiter` transform stream that aborts the transfer if decompressed bytes exceed safety thresholds."

### F8: RFC 7233 Byte-Range Requests & Video Slicing
> "I built RFC 7233 byte-range request handling in `src/range/parse-range.ts` to power seamless media streaming and resume capabilities. When media players request video chunks or seek through an MP4, they send `Range` headers requesting specific byte offsets. The proxy parses these ranges, validates them against the total content length, slices the cached buffer using zero-copy slice operations, and returns a 206 Partial Content response with correct `Content-Range` headers. This prevents re-downloading entire video files and allows smooth video scrubbing."

### F9: Multi-Origin Routing, Active Health Probes & Circuit Breaker
> "I created a resilient multi-origin load balancing and health routing system in `src/config/origins.ts` and `src/health/circuit-breaker.ts`. The proxy distributes cache misses across origin pools using weighted round-robin while a background worker sends active HTTP health probes every five seconds. If an origin server begins returning 500 errors or socket timeouts, its three-state circuit breaker trips to Open, instantly isolating the failing node and failing over to designated backup origins. When the origin recovers, the breaker enters a Half-Open state to test traffic before restoring full traffic flow."

### F10: Edge Security WAF, JWT & Dynamic TLS Termination
> "I built an edge security WAF layer in `src/security/` and `src/tls/` to protect backend origins from unauthorized access and malicious traffic. At the TLS layer, we support dynamic SNI certificate termination with hot-reload watchers that update certificates without restarting the proxy. At the HTTP layer, every request passes through CIDR-based IP allowlists and denylists, Host header spoofing checks, and JWT/OIDC authentication verification. Furthermore, our origin URL validator enforces strict SSRF protection to block attackers from routing requests to internal cloud metadata endpoints."

### F11: Observability: Prometheus & OpenTelemetry
> "I designed the observability architecture in `src/observability/metrics.ts` and `src/observability/tracing.ts` to provide deep visibility into edge cache performance. The proxy exposes standard Prometheus metrics at `/metrics`, tracking edge hit ratio, byte hit ratio, origin latency percentiles, and eviction counts with low-cardinality labels. For distributed tracing, our tracer generates and propagates W3C `traceparent` headers, creating nested spans for cache lookup, upstream fetch, and compression so engineers can pinpoint latency bottlenecks across microservices."

### F12: Admin Control Plane & Embedded SPA
> "I created a standalone administrative control plane in `src/admin/server.ts` running on port 9090. To ensure the admin dashboard is always accessible even during external CDN or NPM outages, I built an embedded single-page application with zero external CDN dependencies, protected by strict CSP nonces. Through this interface and its REST API, site reliability engineers can inspect real-time cache hit ratios, dynamically update origin routing rules, modify cache TTL policies, and manually drain unhealthy origins for maintenance."

### F13: Next.js 14 Real-Time Telemetry Dashboard
> "I built a modern operations dashboard in `frontend/app/dashboard/page.tsx` using Next.js 14, React 18, and Recharts. The dashboard polls the admin telemetry API every second and renders live time-series charts displaying cache hit ratio, byte savings, origin latency p50/p95/p99 histograms, and memory-versus-disk storage utilization. It provides interactive forms to execute instantaneous URL and tag purges, view the real-time request decision ring buffer, and toggle origin maintenance draining with immediate UI updates."

### F14: Ketama Consistent Hash Ring & Peer Proxy Mesh
> "To scale our caching tier horizontally across multiple servers without multiplying upstream load, I built a consistent hashing cluster mesh in `src/cluster/consistent-hashing.ts` using the Ketama algorithm. Each proxy node maps to 160 virtual points on a 32-bit ring. When a request arrives, the proxy hashes the cache key to determine which peer node owns the entry; if owned by another peer, it forwards the request internally with a loop-prevention header. This ensures that adding or removing a cache node moves only 1/Nth of the cached keys, preserving high hit ratios."

### F15: Cache Pre-Warming & Link Header Prefetcher
> "I built an automated cache pre-warming and prefetch engine in `src/warm/warm-prefetch.ts`. When an origin server responds with standard HTTP `Link` headers containing `rel=preload` or `rel=prefetch`, our proxy extracts those URLs and schedules them in a background prefetch queue. The prefetcher crawls the assets during idle cycles with strict concurrency limits and SSRF destination validation, ensuring that critical CSS, JavaScript, and fonts are already warm in edge memory before clients request them."

### F16: AIML Model Layer (Tier A & Tier B Intelligence)
> "In `aiml/`, I specified a tiered AI architecture to augment CDN efficiency. Tier A is a popularity predictor model evaluated against a non-AI baseline to proactively prefetch trending content and guide eviction decisions beyond standard LRU recency. Tier B is an LLM forensic diagnostic assistant that analyzes request decision logs and header configurations to suggest caching optimizations. Crucially, in accordance with resilient systems engineering, the AI models are strictly advisory: the LLM is never on the critical latency or correctness path, and the proxy always defaults to deterministic RFC 9111 rules."
