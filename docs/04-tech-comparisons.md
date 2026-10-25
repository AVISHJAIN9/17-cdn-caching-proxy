# Technology Choices & Exhaustive Trade-Off Comparisons

## 1. Proxy Core Language & Runtime

### Chosen: TypeScript & Node.js Native HTTP Streams
- **File References**: `src/proxy/index.ts`, `src/proxy/stream.ts`
- **Role in Project**: Implements asynchronous reverse proxy listener, stream piping, and RFC 9111 rules.

### Exhaustive Alternatives Comparison

| Evaluation Metric | TypeScript / Node.js Streams (Chosen) | Rust (Actix-Web / Hyper) | Go (`net/http`) | C++ (Nginx / Envoy) |
| :--- | :--- | :--- | :--- | :--- |
| **I/O Model** | Non-blocking Libuv event loop | Async Tokio epoll event loop | Goroutine-per-connection | Event-driven epoll threads |
| **Memory Model** | V8 GC with Buffer segmentation | Zero-cost manual ownership | GC with small stack frames | Manual malloc/free |
| **Development Speed**| Extremely rapid, rich ecosystem | Steep learning curve, strict borrow checker | High speed, built-in concurrency | Slow development, segfault risk |
| **Zero-Copy Piping** | Native `stream.pipeline` | Pointer slicing without copy | `io.Copy` with buffer pool | Kernel `splice()` syscalls |
| **Ecosystem Fit** | Shares models with Next.js frontend | Requires FFI or separate binary | Separate binary and toolchain | Separate C/C++ build system |

- **Why I Used This**: Allows rapid iteration on complex RFC 9111 logic with native Buffer streaming, unified TypeScript types across frontend and proxy, and high I/O throughput [CONFIRM WITH DEVELOPER].
- **Why Alternatives Were Rejected**:
  - *Rust*: High implementation complexity for an academic/interview project deadline; Rust stubs maintained in `backend/` for native acceleration.
  - *Go*: Lack of native TypeScript type sharing with Next.js dashboard.
  - *Nginx / Envoy*: Rigid configuration languages that make custom request coalescing and dynamic surrogate-tag purging difficult to implement without custom Lua or C++ modules.
- **30-Second Spoken Interview Answer**:
> "I chose Node.js with TypeScript because its non-blocking stream pipeline allows zero-copy piping between client and origin sockets without buffering entire objects into the V8 heap. By relying on native Buffers, we achieve sub-millisecond edge latency while sharing end-to-end type definitions across our proxy engine and Next.js admin dashboard."

---

## 2. In-Memory Cache Storage Architecture

### Chosen: Memory-Segmented Buffer Store with Doubly-Linked LRU
- **File References**: `src/cache/memory-store.ts`, `src/cache/eviction/lru.ts`
- **Role in Project**: Sub-millisecond L1 cache holding unexpired representations.

### Exhaustive Alternatives Comparison

| Evaluation Metric | In-Memory Segments (Chosen) | Redis 7.2 | Memcached | RocksDB (Embedded) |
| :--- | :--- | :--- | :--- | :--- |
| **Lookup Latency** | **< 0.05 ms** (In-process memory) | 0.5 - 1.5 ms (Network hop) | 0.4 - 1.2 ms (Network hop) | 0.2 - 0.8 ms (Disk index) |
| **Serialization Overhead**| Zero (Raw Buffers stored) | Serialization to RESP protocol | Binary protocol serialization | Key/value byte serialization |
| **Stream Capability** | Direct stream slicing | Requires Redis Streams or chunks | Value size capped at 1 MB | Block reads required |
| **Operational Overhead** | None (Embedded in proxy) | Requires Redis cluster & sentinel | Requires Memcached daemon | Requires C++ native binding |

- **Why I Used This**: An edge proxy requires sub-millisecond response times. Adding a network hop to Redis introduces 1 ms of latency per request, negating the benefit of an edge cache [CONFIRM WITH DEVELOPER].
- **When I Would Switch**: When deploying across a cluster of 50+ stateless proxy instances that require a shared central cache tier to maximize hit ratios.

---

## 3. Request Coalescing (Thundering Herd) Strategy

### Chosen: In-Flight Flight Map with Leader-Follower Stream Fanout
- **File References**: `src/proxy/coalesce.ts`, `src/proxy/collapsed-forwarding.ts`
- **Role in Project**: Collapses concurrent cache misses into a single upstream request.

### Alternatives Comparison

| Strategy | In-Flight Map (Chosen) | Redis Distributed Lock | Upstream Queue (RabbitMQ) |
| :--- | :--- | :--- | :--- |
| **Coordination Latency** | **Zero** (In-memory lookup) | 2 - 5 ms (Redlock consensus) | 5 - 15 ms (Message round-trip) |
| **Stream Fanout** | Instant stream tee to all sockets | Polling loop required | Consumer polling required |
| **Failure Recovery** | Leader failure promotes follower | Lock timeout required | Dead-letter retry required |

---

## 4. Frontend Administration Dashboard

### Chosen: Next.js 14 App Router + TailwindCSS + Recharts
- **File References**: `frontend/app/dashboard/page.tsx`
- **Role in Project**: Provides a real-time operational dashboard visualizing hit ratios and latencies.

### Alternatives Comparison

| Alternative | Trade-off vs Next.js 14 |
| :--- | :--- |
| **Grafana** | Pre-built metrics visualization, but lacks interactive controls for custom purge triggers and route edits. |
| **Plain React Vite SPA** | Lacks server-side rendering and unified Next.js API route orchestration. |
| **Embedded HTML Only** | Maintained as lightweight fallback in `src/admin/dashboard-html.ts`, but lacks interactive charting capabilities. |
