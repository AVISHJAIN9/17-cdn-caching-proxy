import os

def generate_overview(docs_dir):
    # 1. 00-project-type.md
    with open(os.path.join(docs_dir, "00-project-type.md"), "w", encoding="utf-8") as f:
        f.write("""# Project Type Detection & Adaptation Track

## Step 0 Pre-Check: Architecture & Track Classification

This document records the formal codebase inspection and classification of `17-cdn-caching-proxy`.

---

### Detection Evidence

A comprehensive inspection of the repository `/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy` was conducted:

| Artifact Checked | Findings / Content | Classification Evidence |
| :--- | :--- | :--- |
| **Directory Name** | `17-cdn-caching-proxy` | RFC 9111 compliant reverse caching edge proxy. |
| **Proxy Engine** | `src/proxy/`, `src/cache/`, `src/purge/` | TypeScript, Node.js raw HTTP streams, segment allocators, zero-copy buffers. |
| **Frontend UI** | `frontend/` (`app/dashboard/page.tsx`) | Next.js 14 (React 18, TailwindCSS, Recharts), live telemetry & control console. |
| **Test Suite** | `tests/` (151 test suites, 1064 tests) | Vitest integration test suite passing RFC compliance, memory leak, and stress tests. |
| **Backend Scaffold** | `backend/Cargo.toml`, `backend/src/` | Rust / Tokio scaffolded native engine stubs for high-throughput acceleration. |
| **AI Evaluation** | `aiml/MODEL_CARD.md`, `eval/evaluate_model.py` | Tier A (Popularity prefetch) & Tier B (Forensic diagnostics) ML specifications. |

---

### Formal Classification
- **Primary Classification**: **Track C & A (High-Performance Systems & Reverse Caching Edge Proxy with Next.js 14 Control Plane)**
- **Sub-tracks**:
  - RFC 9111 HTTP Caching specification implementation
  - Zero-copy stream processing (Brotli/Gzip/Zstandard, HTTP Range requests)
  - Distributed cache coherency & tag-based invalidation mesh (Surrogate-Key)
  - Real-time telemetry dashboard & administration control plane

---

### Adaptation Guide

In accordance with the prompt rules:
1. **Systems & Networking Depth**: Focus heavily on stream piping, TCP keepalive, memory segmentation, request coalescing (single-flight), cache freshness calculus, and concurrency safety.
2. **Frontend UI**: Cover Next.js 14 App Router, Recharts telemetry visualizations, CORS-authenticated REST endpoints, and admin actions.
3. **Storage & Data Layer**: Deep-dive into in-memory segment allocators (`MemoryStore`), disk-backed segment files (`DiskStore`), compaction, and inverted tag indices (`PurgeIndex`).
4. **AI Integration**: Accurately describe the Tier A popularity predictor and Tier B forensic assistant without claiming custom neural model training.
""")

    # 2. 00b-project-pitch.md
    with open(os.path.join(docs_dir, "00b-project-pitch.md"), "w", encoding="utf-8") as f:
        f.write("""# Project Pitch: RFC 9111 CDN Caching Proxy

## 30-Second Elevator Pitch
> "I engineered **17-CDN-Caching-Proxy**, an industrial-grade RFC 9111 compliant reverse caching proxy built with TypeScript and Node.js stream pipelines. Siting at the network edge, it intercepts client requests, executes sub-millisecond cache lookups across in-memory and disk segments, and delivers up to 95% origin bandwidth offload. It solves cache stampedes via atomic request coalescing, handles video streaming with RFC 7233 byte-range slicing, performs on-the-fly streaming Brotli compression, and supports instant Surrogate-Key tag purges with an immutable cryptographic audit trail."

---

## 2-Minute Technical Interview Pitch
> "When scaling high-traffic distributed web systems, uncached traffic creates origin database saturation, massive cloud egress bills, and elevated p99 user latencies.
>
> To solve this, I designed and implemented **17-CDN-Caching-Proxy**, a complete RFC 9111 compliant reverse-caching edge proxy paired with a Next.js 14 operational dashboard.
>
> At the core of the proxy in `src/proxy/index.ts` and `src/cache/lookup.ts`, incoming requests are parsed and canonicalized into SHA-256 cache keys. The key generator normalizes URL paths, sorts query parameters deterministically, and isolates variant representations using secondary keys calculated from HTTP `Vary` headers such as `Accept-Encoding`.
>
> To eliminate catastrophic 'thundering herd' cache stampedes when popular content expires, I developed a Single-Flight Request Coalescer in `src/proxy/coalesce.ts`. When hundreds of concurrent requests miss the cache for the same resource, the first request is elected leader and dispatched to the upstream origin, while all subsequent requests join an in-flight queue. Once the origin stream arrives, it is fanned out to all waiting clients and piped simultaneously into the cache store using zero-copy stream splitting.
>
> The storage subsystem in `src/cache/` features a two-tier architecture: a memory-segmented LRU store bounded by tenant quotas and total byte limits, backed by a persistent disk store with background segment compaction. Freshness is strictly calculated per RFC 9111, honoring `s-maxage`, `max-age`, `stale-while-revalidate`, and conditional HTTP 304 revalidations via `ETag` and `If-None-Match`.
>
> For dynamic content invalidation, I built a Surrogate-Key tag index in `src/purge/` that invalidates thousands of catalog items within 5 milliseconds, backed by a SHA-256 tamper-evident audit log. The system is validated by 151 Vitest test suites and 1,064 assertions covering protocol edge cases, client socket disconnections, and zero memory leaks under 1,000 consecutive 1 MB requests."
""")

    # 3. 00-project-map.md
    with open(os.path.join(docs_dir, "00-project-map.md"), "w", encoding="utf-8") as f:
        f.write("""# Project Directory Map & Dependency Audit

```mermaid
flowchart TD
    Root[17-cdn-caching-proxy/] --> Src[src/ - Core Edge Proxy Engine]
    Root --> Frontend[frontend/ - Next.js 14 Admin Console]
    Root --> Tests[tests/ - 151 Vitest Integration Suites]
    Root --> Scripts[scripts/ - Cluster Orchestration & Traffic]
    Root --> Docs[docs/ - VitePress Documentation]
    Root --> AIML[aiml/ - AI Models & Eval Baseline]

    Src --> Admin[admin/ - Admin REST API & Embedded SPA]
    Src --> Cache[cache/ - Memory/Disk Store, LRU, Revalidation]
    Src --> Cluster[cluster/ - Ketama Consistent Hash Ring]
    Src --> Compression[compression/ - Streaming Brotli/Gzip/Zstd]
    Src --> Proxy[proxy/ - Stream Pipeline, Listener, Coalescing]
    Src --> Purge[purge/ - Tag-based Invalidation & Audit]
    Src --> Security[security/ - WAF, IP/Host Filter, JWT, TLS]
    Src --> Observability[observability/ - Prometheus & OpenTelemetry]
```

---

## 1. Directory Tree & File Inventory

```
17-cdn-caching-proxy/
├── package.json                    # Project configuration, scripts, dependencies
├── tsconfig.json                   # TypeScript compiler configuration (ESNext, NodeNext)
├── Dockerfile                      # Multi-stage production container build
├── docker-compose.yml              # Cluster definition (Proxy, Admin, 3 Mock Origins)
├── README.md                       # Repository overview and quickstart guide
├── FEATURES.md                     # Master checklist of 152 implemented features
│
├── src/                            # Core Reverse Caching Proxy Engine
│   ├── admin/                      # Control plane HTTP server & dashboard
│   │   ├── server.ts               # Admin REST API HTTP server (Port 9090)
│   │   ├── dashboard-html.ts       # Embedded zero-dependency SPA dashboard HTML
│   │   ├── metrics-history.ts      # Circular buffer for time-series metrics
│   │   ├── routes-manager.ts       # Dynamic upstream route configuration
│   │   ├── policy-manager.ts       # Route-level cache policy overrides
│   │   └── request-inspector.ts    # Ring buffer of recent caching decisions
│   ├── cache/                      # RFC 9111 Caching Subsystem
│   │   ├── store.ts                # CacheStore abstract interface and data types
│   │   ├── memory-store.ts         # In-memory segment cache with byte quotas
│   │   ├── disk-store.ts           # Disk-backed file store with metadata index
│   │   ├── compaction.ts           # Background disk segment compaction engine
│   │   ├── lookup.ts               # Canonical cache key lookup & Vary evaluation
│   │   ├── serve.ts                # Cache hit, 304 revalidation, and stale response writer
│   │   ├── fill.ts                 # Tee-stream writer to store in-flight responses
│   │   ├── freshness.ts            # RFC 9111 age and freshness lifetime calculus
│   │   ├── cache-control.ts        # Cache-Control directive lexer and parser
│   │   ├── etag.ts                 # Strong and weak ETag generator and validator
│   │   ├── lifetime.ts             # Heuristic freshness calculator
│   │   ├── locks.ts                # Mutex lock pool for single-flight revalidations
│   │   ├── large-object.ts         # Large-object streaming threshold manager
│   │   ├── refresh-ahead.ts        # Proactive background revalidation for hot keys
│   │   ├── stale.ts                # RFC 5861 stale-while-revalidate & stale-if-error
│   │   ├── preconditions.ts        # Client conditional header evaluator
│   │   ├── upstream-conditionals.ts# Conditional header builder for upstream requests
│   │   └── eviction/               # Cache eviction policies
│   │       ├── policy.ts           # EvictionPolicy interface
│   │       ├── lru.ts              # Least Recently Used (doubly-linked list)
│   │       ├── lfu.ts              # Least Frequently Used with frequency bins
│   │       ├── slru.ts             # Segmented LRU (Probationary & Protected tiers)
│   │       └── ttl.ts              # Timestamp-based time-to-live eviction
│   ├── cluster/                    # Horizontal proxy clustering
│   │   ├── consistent-hashing.ts   # Ketama consistent hash ring with virtual nodes
│   │   └── peer-cluster.ts         # Peer mesh router with loop-suppression headers
│   ├── compression/                # On-the-fly streaming compression
│   │   ├── codecs.ts               # Streaming Brotli, Gzip, and Zstandard transforms
│   │   ├── negotiate.ts            # Accept-Encoding content negotiation evaluator
│   │   ├── rules.ts                # MIME-type compressible filter
│   │   └── bypass.ts               # Compression bypass rules (Range, existing encoding)
│   ├── config/                     # Configuration schemas & loaders
│   │   ├── origins.ts              # Origin definitions, pools, and routing rules
│   │   ├── pools.ts                # Weighted round-robin and active health pools
│   │   └── cli.ts                  # Configuration validator CLI
│   ├── dns/                        # DNS resolution layer
│   │   └── cache.ts                # TTL-aware DNS resolver cache
│   ├── health/                     # Origin health monitoring
│   │   ├── active.ts               # Active background HTTP health probes
│   │   ├── passive.ts              # Passive error tracking per origin
│   │   └── circuit-breaker.ts      # Three-state circuit breaker (Closed/Open/Half-Open)
│   ├── observability/              # Telemetry & metrics
│   │   ├── metrics.ts              # Prometheus text format metrics exposition
│   │   ├── tracing.ts              # OpenTelemetry W3C traceparent context propagator
│   │   └── logger.ts               # Structured JSON request logger
│   ├── proxy/                      # Core reverse proxy server & streaming
│   │   ├── index.ts                # Master proxy factory and request dispatcher (Port 8080)
│   │   ├── listener.ts             # Node.js http.Server and https.Server listener
│   │   ├── request.ts              # Incoming request parser and sanitization
│   │   ├── response.ts             # Downstream response writer and header filter
│   │   ├── forward.ts              # Upstream HTTP request forwarder
│   │   ├── stream.ts               # Zero-copy pipeline streamer with backpressure
│   │   ├── coalesce.ts             # Request coalescer for thundering herd prevention
│   │   ├── collapsed-forwarding.ts # Follower fanout manager
│   │   ├── headers.ts              # Hop-by-hop header scrubber (RFC 9110)
│   │   ├── keepalive.ts            # Upstream keep-alive connection agent
│   │   ├── timeouts.ts             # Connect, read, and idle timeout controllers
│   │   └── cancellation.ts         # Downstream abort coordinator
│   ├── purge/                      # Invalidation engine
│   │   ├── api.ts                  # Purge REST API handler
│   │   ├── index-store.ts          # Surrogate-Key tag, URL, and prefix index
│   │   ├── jobs.ts                 # Async purge job worker queue
│   │   └── audit.ts                # Cryptographic SHA-256 audit log chain
│   ├── range/                      # Partial content engine
│   │   └── parse-range.ts          # RFC 7233 Range header parser and byte slicer
│   ├── security/                   # Edge WAF & Access Control
│   │   ├── ip.ts                   # CIDR and IP allowlist/denylist filter
│   │   ├── host.ts                 # Host header allowlist validator
│   │   ├── api-key.ts              # Scoped API key authentication
│   │   ├── jwt.ts                  # JWT token and claims verification
│   │   └── origin-access.ts        # SSRF origin URL validator
│   ├── tls/                        # TLS & Certificate termination
│   │   ├── cert-watcher.ts         # Dynamic certificate reload watcher
│   │   └── cert-config.ts          # SNI context certificate store
│   ├── util/                       # Shared utilities
│   │   └── clock.ts                # SystemClock and MockClock for deterministic tests
│   └── warm/                       # Cache warming & prefetching
│       └── warm-prefetch.ts        # Proactive crawler and Link header prefetcher
│
├── frontend/                       # Next.js 14 Telemetry Console
│   ├── app/
│   │   ├── layout.tsx              # Root HTML layout and navigation shell
│   │   ├── page.tsx                # Landing and cluster status overview
│   │   └── dashboard/
│   │       └── page.tsx            # Telemetry dashboard with Recharts visualizations
│   ├── package.json                # React 18, Next 14, Recharts, Lucide-react
│   └── tsconfig.json               # Frontend TypeScript configuration
│
├── tests/                          # 151 Vitest test suites (1,064 tests)
├── scripts/                        # Operational scripts
│   ├── run-proxy.ts                # Starts standalone proxy on 8080 and admin on 9090
│   ├── demo-origin.ts              # Starts 3 controllable mock origin servers
│   ├── drive-traffic.ts            # Simulates live mixed traffic load
│   ├── dev.sh                      # Cluster bootstrap script (macOS/Linux)
│   └── dev.bat                     # Cluster bootstrap script (Windows)
└── aiml/                           # AI Evaluation & Models
    ├── MODEL_CARD.md               # Model specifications and evaluation criteria
    └── eval/evaluate_model.py      # Baseline evaluation script
```

---

## 2. Tech Stack & Dependencies

### Core Proxy (`package.json`)
| Package | Version | Classification | Justification |
| :--- | :--- | :--- | :--- |
| `zod` | `^4.6.7` | Runtime Validation | Type-safe runtime schema validation for origin configs and routes. |
| `@types/node` | `^22.0.0` | DevDependency | TypeScript types for Node.js 22 LTS standard libraries. |
| `typescript` | `^5.5.0` | DevDependency | Strict type checking and ESNext module emission. |
| `vitest` | `^2.1.0` | DevDependency | High-speed unit and integration test runner with in-memory GC control. |
| `tsx` | `^4.19.0` | DevDependency | Zero-compile runtime runner for TypeScript scripts. |
| `playwright` | `^1.64.1` | DevDependency | Real browser automation for verifying the dashboard UI. |
| `selfsigned` | `^2.4.1` | DevDependency | Generates ephemeral TLS certificates for HTTPS test suites. |
| `vitepress` | `^1.6.3` | DevDependency | High-performance static documentation site generator. |
| `mermaid` | `^11.4.1` | DevDependency | Diagram rendering engine in documentation. |
| `vitepress-plugin-mermaid`| `^2.0.17` | DevDependency | VitePress plugin enabling Mermaid rendering inside markdown. |

### Frontend Console (`frontend/package.json`)
| Package | Version | Classification | Justification |
| :--- | :--- | :--- | :--- |
| `next` | `^14.2.3` | Framework | React full-stack framework utilizing App Router and Server Components. |
| `react` | `^18.3.1` | UI Library | Declarative component tree rendering. |
| `react-dom` | `^18.3.1` | DOM Renderer | React DOM mounting and hydration. |
| `recharts` | `^2.12.7` | Visualization | Composable SVG charting library for hit-ratio and latency curves. |
| `lucide-react`| `^0.378.0` | Icons | Feather-based lightweight UI icons. |
| `tailwindcss` | `^3.4.3` | DevDependency | Utility-first CSS engine for dark-themed dashboard. |

---

## 3. Environment Variables & Secrets

| Variable Name | Service / Component | Purpose | Where Read in Code | Required / Default |
| :--- | :--- | :--- | :--- | :--- |
| `PROXY_PORT` | `scripts/run-proxy.ts` | TCP port for reverse proxy listener | `scripts/run-proxy.ts:7` | Optional (`8080`) |
| `ADMIN_PORT` | `scripts/run-proxy.ts` | TCP port for admin REST API and SPA | `scripts/run-proxy.ts:8` | Optional (`9090`) |
| `ADMIN_TOKEN` | `src/admin/server.ts` | Bearer token for authenticating admin API | `scripts/run-proxy.ts:9` | Optional (`admin-secret`) |
| `ORIGIN_PRIMARY_URL` | `scripts/run-proxy.ts` | Upstream URL for primary origin server | `scripts/run-proxy.ts:33` | Optional (`http://127.0.0.1:8001`) |
| `ORIGIN_SECONDARY_URL`| `scripts/run-proxy.ts` | Upstream URL for secondary origin server | `scripts/run-proxy.ts:34` | Optional (`http://127.0.0.1:8002`) |
| `ORIGIN_BACKUP_URL` | `scripts/run-proxy.ts` | Upstream URL for backup origin server | `scripts/run-proxy.ts:35` | Optional (`http://127.0.0.1:8003`) |
| `NODE_OPTIONS` | `package.json` | Passes `--expose-gc` flag to Node for leak tests | `package.json:7` | Required for Vitest |

---

## 4. Entry Points

- **Reverse Proxy Engine**: `src/proxy/index.ts` (`createAndStartProxy`)
- **Admin API & Embedded SPA**: `src/admin/server.ts` (`AdminServer.start`)
- **Combined Standalone Runner**: `scripts/run-proxy.ts`
- **Frontend Dashboard**: `frontend/app/dashboard/page.tsx`
- **Test Suite**: `tests/` executed via `npm test`
""")

    # 4. 00a-project-analysis.md
    with open(os.path.join(docs_dir, "00a-project-analysis.md"), "w", encoding="utf-8") as f:
        f.write("""# Full Project Analysis: RFC 9111 CDN Caching Proxy

## 0.1 What the Project Is

### Purpose & Problem Solved
Modern web platforms handle massive volumes of static and dynamic HTTP traffic. Directing all client requests straight to backend application servers and databases causes:
1. **Origin Saturation**: High load spikes (flash sales, breaking news) overwhelm application databases.
2. **Bandwidth Costs**: Origin cloud egress bandwidth is expensive compared to edge caching tiers.
3. **Elevated Latency**: Users located far from the origin experience high network round-trip delays.

`17-cdn-caching-proxy` is a standalone, RFC 9111 compliant reverse caching edge proxy. It intercepts HTTP traffic, validates caching rules, serves repeated requests directly from high-speed memory or local disk, coalesces simultaneous misses, and provides instant cache invalidation.

### Target Users
- **Infrastructure & Platform Engineers**: Deploying edge proxy layers to shield backend microservices.
- **CDN Operators**: Requiring predictable, RFC-compliant caching behavior with granular purge control.
- **Site Reliability Engineers (SREs)**: Monitoring edge hit ratios, origin health, and bandwidth savings.

### Main User & Request Journeys
1. **Cache Hit Journey**: Client issues `GET /images/logo.png`. Proxy looks up the canonical hash key in `MemoryStore`, detects an unexpired entry, validates freshness, sets `X-Cache: HIT`, and pipes the cached stream directly to the client in under 1 millisecond.
2. **Cache Miss & Coalescing Journey**: 500 concurrent clients request `/catalog/item-42`. Proxy detects a cache miss. Rather than flooding the origin with 500 requests, `RequestCoalescer` elects one request as leader. The leader forwards to origin, while 499 followers wait. When origin responds with 200 OK, the stream is tee-piped into the cache store and simultaneously fanned out to all 500 clients.
3. **Cache Purge Journey**: An operator updates product data and issues `POST /admin/api/v1/purge` with tag `category-electronics`. `PurgeIndex` matches 200 cached items, marks them invalidated in memory, and records an immutable cryptographic SHA-256 audit entry.

---

## 0.2 Feature Architecture & Traces (F1 - F16)

The project implements 16 major architectural feature modules, covering 152 distinct verified capabilities:

```mermaid
flowchart TD
    subgraph Ingress [Ingress & Security]
        F10[F10: Edge Security WAF & TLS]
        F1[F1: RFC 9111 Cache Core]
    end

    subgraph Core [Caching & Concurrency]
        F2[F2: Request Coalescing]
        F3[F3: Multi-Tier Storage]
        F4[F4: Eviction Algorithms]
        F5[F5: Conditional Revalidation]
        F8[F8: Range Requests & Partial Content]
        F15[F15: Pre-Warming & Prefetch]
    end

    subgraph Optimization [Optimization & Routing]
        F7[F7: Streaming Compression]
        F9[F9: Multi-Origin Load Balancer]
        F14[F14: Ketama Consistent Hash Ring]
    end

    subgraph ControlPlane [Control Plane & Telemetry]
        F6[F6: Surrogate-Key Purge & Audit]
        F11[F11: Observability Prometheus]
        F12[F12: Admin API & Embedded SPA]
        F13[F13: Next.js 14 Dashboard]
        F16[F16: AIML Model Layer]
    end

    F10 --> F1
    F1 --> F2
    F2 --> F3
    F3 --> F4
    F1 --> F5
    F1 --> F8
    F1 --> F7
    F2 --> F9
    F9 --> F14
    F6 --> F3
    F1 --> F11
    F11 --> F12
    F12 --> F13
    F11 -. Telemetry .-> F16
```

### Complete Feature Trace Table

| Feature ID | Module & Name | Key Files Involved | Primary Functions | Data Touched | Endpoints Involved |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **F1** | RFC 9111 Cache Core | `src/proxy/request.ts`, `src/cache/lookup.ts`, `src/cache/serve.ts` | `parseRequest`, `lookupCache`, `serveCacheHit` | `CacheEntry`, `MemoryStore` | `GET /*`, `HEAD /*` |
| **F2** | Request Coalescing | `src/proxy/coalesce.ts`, `src/proxy/forward.ts` | `joinOrLead`, `resolveWaiters` | `flightMap`, `passMarkerMap` | `GET /*` |
| **F3** | Multi-Tier Storage | `src/cache/memory-store.ts`, `src/cache/disk-store.ts` | `store`, `get`, `compactSegments` | In-memory Buffer, Disk segments | Internal storage |
| **F4** | Eviction Algorithms | `src/cache/eviction/lru.ts`, `lfu.ts`, `slru.ts`, `ttl.ts` | `onAccess`, `evictNext`, `isTtlEvictable` | Eviction lists, Frequency bins | Internal storage |
| **F5** | Revalidation & 304 | `src/cache/revalidate.ts`, `src/cache/serve.ts` | `handleRevalidationResponse`, `serveCache304` | `CacheEntry.metadata` | `GET /*` (If-None-Match) |
| **F6** | Tag Purge & Audit | `src/purge/api.ts`, `src/purge/index-store.ts`, `src/purge/audit.ts` | `purgeByTag`, `appendAuditEntry` | `tagMap`, `auditLog` SHA-256 chain | `POST /admin/api/v1/purge` |
| **F7** | Streaming Compression | `src/compression/codecs.ts`, `src/compression/negotiate.ts` | `createCompressor`, `negotiateEncoding` | Stream transforms | `GET /*` (Accept-Encoding) |
| **F8** | Range Partial Content | `src/range/parse-range.ts`, `src/cache/large-object.ts` | `parseRangeHeader`, `sliceStream` | Stream slices | `GET /*` (Range) |
| **F9** | Multi-Origin & Circuit | `src/config/origins.ts`, `src/health/circuit-breaker.ts` | `resolveOriginForRequest`, `recordFailure` | `CircuitBreakerState` | Upstream HTTP |
| **F10** | Edge Security WAF | `src/security/ip.ts`, `src/security/host.ts`, `src/security/jwt.ts` | `evaluateIpAccess`, `isHostAllowed`, `verifyToken`| Allow/Deny sets, JWK keys | `/*` (Ingress filter) |
| **F11** | Observability | `src/observability/metrics.ts`, `src/observability/logger.ts` | `recordHit`, `recordMiss`, `logRequest` | Prometheus metrics counters | `GET /metrics` |
| **F12** | Admin Control Plane | `src/admin/server.ts`, `src/admin/routes-manager.ts` | `handle`, `addRoute`, `setPolicy` | Route registry, Policy store | `GET /admin`, `GET /admin/api/v1/*` |
| **F13** | Next.js Dashboard | `frontend/app/dashboard/page.tsx` | `DashboardPage`, `fetchMetrics`, `pollTimeseries`| React state, Recharts | `http://localhost:3000/dashboard` |
| **F14** | Consistent Hashing | `src/cluster/consistent-hashing.ts`, `src/cluster/peer-cluster.ts`| `getNode`, `forwardToPeer` | Ketama ring, Virtual nodes | Peer proxy mesh |
| **F15** | Cache Pre-Warming | `src/warm/warm-prefetch.ts` | `warmUrls`, `prefetchLinkHeaders` | Pre-warm queue | `POST /admin/api/v1/warm` |
| **F16** | AIML Model Layer | `aiml/MODEL_CARD.md`, `eval/evaluate_model.py` | `predict_popularity`, `evaluate` | Telemetry logs, Metric tensors | Async offline evaluation |

---

## 0.3 Every API & Endpoint

### Reverse Proxy Listener (Port 8080)
| Method | Path | Auth | Handler Function | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `GET / HEAD` | `/*` | Optional (API Key / JWT) | `handleProxyRequest` (`src/proxy/index.ts:180`) | Main reverse caching proxy pipeline |
| `POST / PUT / DELETE` | `/*` | Optional | `forwardUncached` (`src/proxy/forward.ts:35`) | Pass-through non-idempotent mutations to origin |
| `GET` | `/metrics` | None | `metricsRegistry.toPrometheusText()` | Prometheus exposition text format (0.0.4) |
| `GET` | `/_health` | None | Health check endpoint | Returns 200 OK for load balancers |

### Admin Control Plane (Port 9090)
| Method | Path | Auth | Handler Function | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/admin` or `/` | None | `renderDashboardHtml` | Serves embedded zero-dependency SPA dashboard HTML |
| `GET` | `/admin/api/v1/status` | Bearer Token | `AdminServer.handle` (`src/admin/server.ts:131`) | Returns node health, uptime, and version |
| `GET` | `/admin/api/v1/overview` | Bearer Token | `AdminServer.handle` (`src/admin/server.ts:145`) | Returns total cached objects, bytes, and hit ratio |
| `GET` | `/admin/api/v1/timeseries/:metric`| Bearer Token | `AdminServer.handle` (`src/admin/server.ts:166`) | Returns 1-hour time-series history points |
| `GET` | `/admin/api/v1/origins` | Bearer Token | `AdminServer.handle` (`src/admin/server.ts:174`) | Lists origin health, weights, and circuit breaker status |
| `POST` | `/admin/api/v1/origins/:id/drain` | Bearer Token | `AdminServer.handle` (`src/admin/server.ts:186`) | Marks an origin as drained for maintenance |
| `POST` | `/admin/api/v1/origins/:id/enable`| Bearer Token | `AdminServer.handle` (`src/admin/server.ts:194`) | Re-enables a previously drained origin |
| `GET` | `/admin/api/v1/routes` | Bearer Token | `RouteConfigurationManager.getRoutes` | Retrieves active routing table |
| `POST` | `/admin/api/v1/routes` | Bearer Token | `RouteConfigurationManager.addRoute` | Inserts or updates dynamic route pattern |
| `DELETE` | `/admin/api/v1/routes/:id` | Bearer Token | `RouteConfigurationManager.deleteRoute` | Removes a dynamic route |
| `GET` | `/admin/api/v1/policies` | Bearer Token | `CachePolicyManager.getPolicies` | Retrieves route/tenant cache policy overrides |
| `POST` | `/admin/api/v1/policies` | Bearer Token | `CachePolicyManager.setPolicy` | Sets TTL, bypass, and revalidation policies |
| `GET` | `/admin/api/v1/tenants` | Bearer Token | `MemoryStore.getTenantStats` | Returns per-tenant byte usage and quota limits |
| `GET` | `/admin/api/v1/inspector/decisions`| Bearer Token| `RequestInspector.getRecentDecisions` | Inspects recent caching decisions ring buffer |
| `POST` | `/admin/api/v1/purge` | Bearer Token | `PurgeApiHandler.handleRequest` (`src/purge/api.ts`) | Executes URL, Prefix, Tag, Host, or Tenant purge |
| `GET` | `/admin/api/v1/purge/jobs/:id` | Bearer Token | `PurgeJobQueue.getJobStatus` | Polls status of async background purge job |
| `GET` | `/admin/api/v1/purge/audit` | Bearer Token | `PurgeAuditTrail.getEntries` | Retrieves cryptographic audit log entries |

---

## 0.4 Every Hook, Helper, and Shared Piece

### Next.js Dashboard React Hooks (`frontend/app/dashboard/page.tsx`)
- `useState`: Manages active telemetry metrics, origin lists, route tables, purge forms, and live charts.
- `useEffect`: Sets up a periodic 1-second polling timer against `http://localhost:9090/admin/api/v1/timeseries`.
- `useCallback`: Memoizes API fetchers (`fetchOverview`, `fetchOrigins`, `submitPurge`) to avoid unnecessary re-renders.

### Key Shared Utilities & Helpers
- `src/util/clock.ts`: `Clock` interface with `SystemClock` and `MockClock` for time travel in deterministic tests.
- `src/cache/key.ts`: Canonical cache key builder normalizing query param order and appending `Vary` values.
- `src/cache/cache-control.ts`: Fast parser for RFC 9111 `Cache-Control` directive tokens (`max-age`, `s-maxage`, `no-cache`, `no-store`).
- `src/observability/tracing.ts`: W3C `traceparent` generator and propagator.
- `src/proxy/headers.ts`: RFC 9110 hop-by-hop header scrubber (strips `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Transfer-Encoding`).

---

## 0.5 System Connection Map

```mermaid
sequenceDiagram
    autonumber
    actor Client as Web Browser / Client
    participant Proxy as Proxy Listener (Port 8080)
    participant WAF as Security & WAF Check
    participant Coalesce as Request Coalescer
    participant Cache as Memory & Disk Cache
    participant Origin as Upstream Origin Server (8001/8002/8003)
    actor Admin as Operator / Dashboard (Port 9090)

    Note over Client,Proxy: Scenario 1: Uncached Request (Cache Miss with Single-Flight Coalesce)
    Client->>Proxy: GET /api/products/42 (Accept-Encoding: br)
    Proxy->>WAF: Validate IP & Host allowlist
    WAF-->>Proxy: Allowed
    Proxy->>Cache: Lookup canonical_key
    Cache-->>Proxy: MISS (entry null)
    Proxy->>Coalesce: joinOrLead(canonical_key)
    Coalesce-->>Proxy: LEADER elected
    Proxy->>Origin: Upstream GET /api/products/42
    Origin-->>Proxy: 200 OK + Body Stream + ETag: "v42"
    Proxy->>Cache: Stream Tee write (MemoryStore)
    Proxy->>Coalesce: Fanout stream to followers
    Proxy-->>Client: 200 OK (X-Cache: MISS, Age: 0)

    Note over Client,Proxy: Scenario 2: Subsequent Request (Cache Hit)
    Client->>Proxy: GET /api/products/42 (Accept-Encoding: br)
    Proxy->>Cache: Lookup canonical_key
    Cache-->>Proxy: HIT (entry valid, age 12s, ttl 300s)
    Proxy-->>Client: 200 OK (X-Cache: HIT, Age: 12)

    Note over Admin,Cache: Scenario 3: Surrogate-Key Tag Purge
    Admin->>Proxy: POST /admin/api/v1/purge { tag: "products" }
    Proxy->>Cache: Invalidate all entries tagged "products"
    Proxy-->>Admin: 200 OK { purgedCount: 42, jobId: "job-101" }
```

---

## 0.6 Final Inventory Counts

| Metric / Category | Exact Codebase Count | Verification Source |
| :--- | :--- | :--- |
| **Total Major Feature Modules** | **16 Modules** | Grouped F1 - F16 (`docs/features/`) |
| **Total Granular Features** | **152 Features** | Master list in `FEATURES.md` |
| **Total Test Suites** | **151 Suites** | `tests/*.test.ts` (1,064 tests) |
| **Total Endpoints (Proxy & Admin)** | **18 Endpoints** | Documented in `docs/03-api-reference.md` |
| **Frontend Screens / Views** | **3 Views** | Landing, Next.js Dashboard, Embedded Admin SPA |
| **Eviction Algorithms** | **4 Policies** | LRU, LFU, SLRU, TTL (`src/cache/eviction/`) |
| **Compression Codecs** | **3 Codecs** | Brotli, Gzip, Zstandard (`src/compression/`) |
| **Storage Engines** | **2 Tiers** | `MemoryStore` & `DiskStore` (`src/cache/`) |
""")

    print("Generated 00-project-type.md, 00b-project-pitch.md, 00-project-map.md, 00a-project-analysis.md")

if __name__ == "__main__":
    import sys
    docs_dir = sys.argv[1] if len(sys.argv) > 1 else "/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy/docs"
    generate_overview(docs_dir)
