import os

def generate_misc(docs_dir, root_dir):
    theme_dir = os.path.join(docs_dir, ".vitepress", "theme")
    os.makedirs(theme_dir, exist_ok=True)

    # 1. 10-gaps-and-improvements.md
    with open(os.path.join(docs_dir, "10-gaps-and-improvements.md"), "w", encoding="utf-8") as f:
        f.write("""# Technical Debt, Known Gaps & Future Improvements

This document outlines the architectural trade-offs, known gaps, and engineering roadmap for `17-cdn-caching-proxy`.

---

## 1. Ranked Technical Gaps & Roadmap

| Priority | Gap Title | Description | Remediation Plan |
| :--- | :--- | :--- | :--- |
| **P1** | Distributed Purge Mesh | Purge events are currently in-process or relayed via peer HTTP calls. In large clusters, a node network partition can cause stale cache states. | Implement a distributed Redis Pub/Sub or Kafka invalidation bus with vector clocks for cluster-wide cache invalidation. |
| **P2** | Persistent RocksDB Storage | `DiskStore` relies on flat segment files with manual compaction. Under extreme write churn, fragmentation increases disk I/O. | Integrate embedded RocksDB or LMDB via native bindings for LSM-tree SSD caching. |
| **P3** | HTTP/3 (QUIC) Ingress | Proxy listener currently supports HTTP/1.1 and HTTPS. Clients on mobile networks experience TCP head-of-line blocking. | Introduce HTTP/3 and QUIC protocol support using Node.js experimental quic or an eBPF front-door envoy proxy. |
| **P4** | Off-Heap Slab Allocation | While memory leak tests pass, large Buffers in V8 memory trigger heap compaction during peak allocations. | Implement an off-heap native C++ memory arena with fixed 64KB slab allocators. |

---

## 2. Technical Debt Knowingly Taken
1. **In-Memory Flight Map**: Request coalescing tracks flights in a local JavaScript `Map`. This is exceptionally fast, but limits coalescing to requests arriving on the exact same proxy instance.
2. **Simplified Zstandard Support**: Zstandard compression leverages native Node.js zlib where supported, falling back to Brotli on systems without zstd bindings.
""")

    # 2. 11-glossary.md
    with open(os.path.join(docs_dir, "11-glossary.md"), "w", encoding="utf-8") as f:
        f.write("""# Technical Glossary & Concepts Reference

A comprehensive dictionary of systems engineering, HTTP caching, and networking terminology used in `17-cdn-caching-proxy`.

---

## Caching & Networking Terms

- **RFC 9111**: The modern IETF standard specification governing HTTP Caching semantics, replacing RFC 7234.
- **Request Coalescing (Single-Flight)**: An architectural pattern that intercepts multiple concurrent requests for the same uncached resource and collapses them into a single upstream request, protecting origins from thundering herd stampedes.
- **Surrogate-Key (Cache-Tag)**: A response header containing space-separated identifiers that tag cached representations, enabling bulk invalidation of related resources in O(1) time.
- **Stale-While-Revalidate (RFC 5861)**: A Cache-Control directive instructing the proxy to serve an expired cached entry immediately to the client while asynchronously dispatching a background request to fetch fresh content.
- **Stale-If-Error (RFC 5861)**: A Cache-Control directive allowing the proxy to serve an expired cached response if the upstream origin returns a 5xx error or network timeout.
- **Canonical Cache Key**: A normalized SHA-256 hash derived from the request URL, query parameters (sorted deterministically), and secondary keys from `Vary` headers.
- **Segmented LRU (SLRU)**: An eviction algorithm that divides cache space into probationary and protected segments, requiring an asset to be accessed at least twice before entering the protected tier.
- **Ketama Consistent Hashing**: A deterministic hashing algorithm that maps cache keys and server nodes onto a 32-bit ring with virtual nodes, minimizing key migration during node additions or removals.
- **Zero-Copy Stream Piping**: Transferring raw byte chunks from an ingress socket to an egress socket without deserializing the payload into intermediate application memory.
- **Content Negotiation**: The HTTP mechanism (`Accept-Encoding` vs `Content-Encoding`) allowing clients and proxies to negotiate optimal data formats such as Brotli or Gzip.
""")

    # 3. 12-confirm-list.md
    with open(os.path.join(docs_dir, "12-confirm-list.md"), "w", encoding="utf-8") as f:
        f.write("""# Architecture Decisions Confirmation List [CONFIRM WITH DEVELOPER]

The following design decisions and operational assumptions were deduced from the codebase and should be confirmed by the primary engineer:

| Item # | Topic | Deduced Design Choice | Location in Codebase | Rationale to Confirm |
| :--- | :--- | :--- | :--- | :--- |
| **C1** | Storage Tiering | Defaulting to in-memory `MemoryStore` with flat segment `DiskStore` fallback instead of Redis. | `src/cache/store.ts` | Selected to achieve true sub-millisecond lookups (< 0.1ms) without external network hops. |
| **C2** | Coalescing Policy | In-flight leader-follower stream fanout instead of queuing in Redis/RabbitMQ. | `src/proxy/coalesce.ts` | Eliminates distributed locking overhead; maximizes local proxy throughput. |
| **C3** | Purge Strategy | Synchronous purge for < 50 items; asynchronous worker queue for > 50 items. | `src/purge/api.ts:25` | Prevents event loop blocking during massive tenant or tag purge operations. |
| **C4** | AIML Tier Role | Tier A/B models strictly advisory; zero AI models placed on critical latency path. | `aiml/MODEL_CARD.md` | Ensures strict deterministic RFC 9111 correctness and avoids latency jitter. |
| **C5** | Compression Cap | Brotli compression level capped at 6 instead of 11. | `src/compression/codecs.ts` | Balances CPU consumption against byte savings during high-throughput edge proxying. |
""")

    # 4. 14-say-it-out-loud.md
    with open(os.path.join(docs_dir, "14-say-it-out-loud.md"), "w", encoding="utf-8") as f:
        f.write("""# Master 'Say It Out Loud' Interview Rehearsal Scripts

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
""")

    # 5. README.md & index.md
    with open(os.path.join(docs_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write("""# RFC 9111 CDN Caching Proxy: Documentation Suite

Welcome to the definitive engineering documentation and interview preparation guide for **17-CDN-Caching-Proxy**.

---

## Documentation Reading Order

1. **[00-project-type.md](./00-project-type.md)**: Architecture classification & track adaptation.
2. **[00a-project-analysis.md](./00a-project-analysis.md)**: Full codebase analysis, inventory counts, and data flow map.
3. **[00b-project-pitch.md](./00b-project-pitch.md)**: 30-second and 2-minute elevator pitches.
4. **[00-project-map.md](./00-project-map.md)**: Complete file hierarchy, tech stack, and dependencies.
5. **[01-features.md](./01-features.md)**: Master feature inventory (F1 to F16) with individual feature specs.
6. **[02-build-order.md](./02-build-order.md)**: Dependency-ordered rebuild guide from scratch.
7. **[03-api-reference.md](./03-api-reference.md)**: Complete reference of all Proxy and Admin REST endpoints.
8. **[04-tech-comparisons.md](./04-tech-comparisons.md)**: Exhaustive technology choice comparison tables.
9. **[05-architecture.md](./05-architecture.md)**: Deep architectural flows, sequence diagrams, and data paths.
10. **[06-security.md](./06-security.md)**: OWASP Top 10 mapping, cache poisoning defense, and WAF rules.
11. **[07-ai-integration.md](./07-ai-integration.md)**: Tier A popularity forecasting and Tier B forensic assistant.
12. **[08-quality-and-ops.md](./08-quality-and-ops.md)**: Test suites, memory leak validation, Docker, and Kubernetes.
13. **[09-interview-qa.md](./09-interview-qa.md)**: 150+ in-depth technical interview questions and answers.
14. **[10-gaps-and-improvements.md](./10-gaps-and-improvements.md)**: Technical debt and engineering roadmap.
15. **[11-glossary.md](./11-glossary.md)**: Comprehensive dictionary of networking and caching concepts.
16. **[12-confirm-list.md](./12-confirm-list.md)**: Decisions marked [CONFIRM WITH DEVELOPER].
17. **[13-master-checklist.md](./13-master-checklist.md)**: Master 275-point checklist with coverage status table.
18. **[14-say-it-out-loud.md](./14-say-it-out-loud.md)**: Spoken first-person interview scripts and rehearsal checklist.
19. **[System Design Deep Dive](./system-design/)**: 17 dedicated distributed systems chapters and ADR log.
""")

    with open(os.path.join(docs_dir, "index.md"), "w", encoding="utf-8") as f:
        f.write("""---
layout: home

hero:
  name: "CDN Caching Proxy"
  text: "RFC 9111 Compliant Edge Cache"
  tagline: "Industrial-grade reverse caching edge proxy in TypeScript and Node.js streams."
  actions:
    - theme: brand
      text: Project Overview
      link: /00a-project-analysis
    - theme: alt
      text: Interview Q&A (150+)
      link: /09-interview-qa
    - theme: alt
      text: Master Checklist (275)
      link: /13-master-checklist

features:
  - title: "RFC 9111 Compliant"
    details: "Strict Cache-Control, ETag, Age, and conditional 304 revalidation rules."
    link: /01-features
  - title: "Single-Flight Coalescing"
    details: "Eliminates thundering herds by collapsing 500+ misses into 1 origin fetch."
    link: /features/F2-request-collapsing
  - title: "Sub-5ms Tag Purge"
    details: "Surrogate-Key inverted tag indexing backed by a SHA-256 audit log."
    link: /features/F6-surrogate-key-purge
  - title: "151 Test Suites Passing"
    details: "1,064 automated assertions covering memory leaks and protocol edge cases."
    link: /08-quality-and-ops
---
""")

    # 6. VitePress Theme & Config
    with open(os.path.join(theme_dir, "custom.css"), "w", encoding="utf-8") as f:
        f.write(""":root {
  --vp-c-brand: #06b6d4;
  --vp-c-brand-light: #22d3ee;
  --vp-c-brand-dark: #0891b2;
}

.dark {
  --vp-c-bg: #000000 !important;
  --vp-c-bg-alt: #000000 !important;
  --vp-c-bg-elv: #0a0a0a !important;
  --vp-c-bg-soft: #0a0a0a !important;
  --vp-sidebar-bg-color: #000000 !important;
  --vp-c-border: #222222 !important;
  --vp-c-divider: #222222 !important;
}

html.dark body {
  background-color: #000000 !important;
  color: #f1f5f9;
}
""")

    with open(os.path.join(theme_dir, "index.js"), "w", encoding="utf-8") as f:
        f.write("""import DefaultTheme from 'vitepress/theme';
import './custom.css';

export default {
  ...DefaultTheme
};
""")

    with open(os.path.join(docs_dir, ".vitepress", "config.mjs"), "w", encoding="utf-8") as f:
        f.write("""import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: '17-CDN-Caching-Proxy',
    description: 'RFC 9111 compliant reverse-caching CDN edge proxy in TypeScript.',
    appearance: 'dark',
    base: '/',
    themeConfig: {
      nav: [
        { text: 'Guide', link: '/00a-project-analysis' },
        { text: 'Features', link: '/01-features' },
        { text: 'API Reference', link: '/03-api-reference' },
        { text: 'System Design', link: '/system-design/' },
        { text: 'Interview Q&A', link: '/09-interview-qa' },
        { text: 'Master Checklist', link: '/13-master-checklist' }
      ],
      sidebar: [
        {
          text: 'Project Overview',
          items: [
            { text: 'Project Type', link: '/00-project-type' },
            { text: 'Project Analysis', link: '/00a-project-analysis' },
            { text: 'Project Pitch', link: '/00b-project-pitch' },
            { text: 'Project Map', link: '/00-project-map' }
          ]
        },
        {
          text: 'Features (F1 - F16)',
          items: [
            { text: 'Feature Inventory', link: '/01-features' },
            { text: 'F1: RFC 9111 Cache Core', link: '/features/F1-rfc9111-cache-core' },
            { text: 'F2: Request Coalescing', link: '/features/F2-request-collapsing' },
            { text: 'F3: Multi-Tier Storage', link: '/features/F3-multi-tier-storage' },
            { text: 'F4: Eviction Algorithms', link: '/features/F4-eviction-algorithms' },
            { text: 'F5: Conditional Revalidation', link: '/features/F5-conditional-revalidation' },
            { text: 'F6: Surrogate Tag Purge', link: '/features/F6-surrogate-key-purge' },
            { text: 'F7: Streaming Compression', link: '/features/F7-streaming-compression' },
            { text: 'F8: Byte-Range Slicing', link: '/features/F8-byte-range-requests' },
            { text: 'F9: Multi-Origin Routing', link: '/features/F9-multi-origin-health' },
            { text: 'F10: Edge Security WAF', link: '/features/F10-edge-security-waf' },
            { text: 'F11: Observability Metrics', link: '/features/F11-observability-metrics' },
            { text: 'F12: Admin Control Plane', link: '/features/F12-admin-control-plane' },
            { text: 'F13: Next.js 14 Dashboard', link: '/features/F13-nextjs-telemetry-dashboard' },
            { text: 'F14: Ketama Consistent Hashing', link: '/features/F14-consistent-hashing-cluster' },
            { text: 'F15: Cache Pre-Warming', link: '/features/F15-cache-prewarming' },
            { text: 'F16: AIML Tier Models', link: '/features/F16-aiml-tier-models' }
          ]
        },
        {
          text: 'Guides & Specifications',
          items: [
            { text: 'Build Order', link: '/02-build-order' },
            { text: 'API Reference', link: '/03-api-reference' },
            { text: 'Tech Comparisons', link: '/04-tech-comparisons' },
            { text: 'Architecture Deep Dive', link: '/05-architecture' },
            { text: 'Edge Security', link: '/06-security' },
            { text: 'AI Architecture', link: '/07-ai-integration' },
            { text: 'Quality & Testing', link: '/08-quality-and-ops' }
          ]
        },
        {
          text: 'System Design Deep Dive (17 Topics)',
          items: [
            { text: 'System Design Overview', link: '/system-design/' },
            { text: '14.1 Capacity Estimation', link: '/system-design/14.1-requirements-and-estimation' },
            { text: '14.2 Architecture Styles', link: '/system-design/14.2-architecture-styles' },
            { text: '14.3 Networking & HTTP', link: '/system-design/14.3-networking-and-communication' },
            { text: '14.4 Load Balancing & Scaling', link: '/system-design/14.4-load-balancing-and-scaling' },
            { text: '14.5 Storage Architecture', link: '/system-design/14.5-databases-and-storage' },
            { text: '14.6 Deep Caching', link: '/system-design/14.6-caching' },
            { text: '14.7 Messaging & Queues', link: '/system-design/14.7-messaging-and-queues' },
            { text: '14.8 Consistency & Concurrency', link: '/system-design/14.8-consistency-and-concurrency' },
            { text: '14.9 Reliability & Resilience', link: '/system-design/14.9-reliability-and-resilience' },
            { text: '14.10 API Design & Quotas', link: '/system-design/14.10-api-design-and-rate-limiting' },
            { text: '14.11 Security Architecture', link: '/system-design/14.11-security-architecture' },
            { text: '14.12 Search & AI Architecture', link: '/system-design/14.12-search-and-ai-architecture' },
            { text: '14.13 Real-Time Telemetry', link: '/system-design/14.13-real-time-systems' },
            { text: '14.14 Observability & Operations', link: '/system-design/14.14-observability-and-operations' },
            { text: '14.15 Performance Engineering', link: '/system-design/14.15-performance-engineering' },
            { text: '14.16 Cost & Trade-offs', link: '/system-design/14.16-cost-and-trade-offs' },
            { text: '14.17 Classic Questions', link: '/system-design/14.17-classic-system-design' },
            { text: 'Architecture Decisions (ADR)', link: '/system-design/decisions' }
          ]
        },
        {
          text: 'Interview & Quality Assurance',
          items: [
            { text: 'Interview Q&A (150+)', link: '/09-interview-qa' },
            { text: 'Gaps & Roadmap', link: '/10-gaps-and-improvements' },
            { text: 'Glossary', link: '/11-glossary' },
            { text: 'Confirm List', link: '/12-confirm-list' },
            { text: 'Master Checklist (275)', link: '/13-master-checklist' },
            { text: 'Say It Out Loud', link: '/14-say-it-out-loud' }
          ]
        }
      ],
      search: {
        provider: 'local'
      },
      outline: [2, 3]
    },
    mermaid: {
      theme: 'dark'
    },
    vite: {
      optimizeDeps: {
        include: ['mermaid', 'fastdom', 'fastdom/extensions/fastdom-promised.js']
      },
      ssr: {
        noExternal: ['mermaid', 'vitepress-plugin-mermaid', 'fastdom']
      }
    }
  })
);
""")

    print("Generated 10-gaps-and-improvements.md, 11-glossary.md, 12-confirm-list.md, 14-say-it-out-loud.md, README.md, index.md, and .vitepress theme/config.")

if __name__ == "__main__":
    import sys
    docs_dir = sys.argv[1] if len(sys.argv) > 1 else "/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy/docs"
    root_dir = sys.argv[2] if len(sys.argv) > 2 else "/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy"
    generate_misc(docs_dir, root_dir)
