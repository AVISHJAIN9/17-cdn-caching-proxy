# Architecture & End-to-End System Design

## 1. High-Level Architecture Overview

```mermaid
flowchart TD
    User([Public Clients]) -->|HTTPS / Port 8080| ProxyListener[Proxy Ingress Listener]
    Admin([SRE / Operator]) -->|HTTP / Port 9090| AdminServer[Admin Server & Dashboard]

    subgraph EdgeProxyEngine [Edge Proxy Core Process]
        ProxyListener --> WAF[WAF, IP & Host Filter]
        WAF --> KeyGen[Canonical Key & Hash Engine]
        KeyGen --> Lookup[Cache Lookup Engine]

        Lookup -->|Cache HIT| ServeHit[Serve Cache Hit Stream]
        Lookup -->|Cache MISS| Coalescer[Request Coalescer]

        Coalescer -->|Leader Request| OriginRouter[Origin Router & Load Balancer]
        Coalescer -->|Follower Wait| WaiterQueue[(In-Flight Waiters)]

        OriginRouter -->|HTTP Pool| PrimaryOrigin[(Primary Origin: 8001)]
        OriginRouter -->|Failover| SecondaryOrigin[(Secondary Origin: 8002)]

        PrimaryOrigin -->|Response Stream| TeeStream[Stream Tee Allocator]
        TeeStream -->|Save| MemoryStore[(In-Memory Buffer Store)]
        TeeStream -->|Save Large| DiskStore[(Disk Segment Store)]
        TeeStream -->|Fanout Stream| WaiterQueue
        TeeStream -->|Direct Response| ClientSocket[Client HTTP Socket]
    end

    subgraph ControlPlane [Control Plane & Telemetry]
        AdminServer --> PurgeEngine[Surrogate-Key Purge Index]
        AdminServer --> RouteManager[Dynamic Route Config]
        AdminServer --> MetricsRegistry[Prometheus Metrics]
        PurgeEngine --> MemoryStore
        PurgeEngine --> DiskStore
        MetricsRegistry --> PrometheusScraper([Prometheus Collector])
    end
```

---

## 2. Request Lifecycle Traces

### 2.1 Cache Hit Lifecycle (< 1 ms)
1. Client sends `GET /static/app.js` with `Accept-Encoding: br`.
2. `src/proxy/index.ts` validates Host header and IP allowlist.
3. `src/cache/key.ts` computes canonical SHA-256 hash: `sha256(https://example.com/static/app.js + vary:br)`.
4. `src/cache/lookup.ts` finds matching `CacheEntry` in `MemoryStore`.
5. `src/cache/freshness.ts` verifies: `current_age < max_age`.
6. `src/cache/serve.ts` sets `X-Cache: HIT`, `Age: 42`, and pipes buffer directly to downstream client socket.

### 2.2 Cache Miss with Single-Flight Coalescing
```mermaid
sequenceDiagram
    autonumber
    actor ClientA as Client A (Arrives t=0ms)
    actor ClientB as Client B (Arrives t=2ms)
    participant Coalesce as RequestCoalescer
    participant Origin as Upstream Origin
    participant Cache as MemoryStore

    ClientA->>Coalesce: joinOrLead("key-banner")
    Coalesce-->>ClientA: Elected LEADER
    ClientB->>Coalesce: joinOrLead("key-banner")
    Coalesce-->>ClientB: Registered FOLLOWER (Paused)

    ClientA->>Origin: Upstream GET /banner.jpg
    Origin-->>ClientA: 200 OK + Stream Chunks

    ClientA->>Cache: Stream Tee write (CacheEntry)
    ClientA->>ClientB: Fanout chunk broadcast
    ClientA-->>ClientA: Pipe chunk to socket
    ClientB-->>ClientB: Pipe chunk to socket
```

---

## 3. Scaling to 100x Traffic & Bottleneck Elimination

At 100x traffic (50,000+ requests per second):
1. **Bottleneck 1: Node.js Single-Threaded Event Loop**:
   - *Fix*: Scale proxy horizontally across multi-core servers using Linux `SO_REUSEPORT` kernel socket load balancing or deploy multi-process worker clusters.
2. **Bottleneck 2: In-Memory Heap GC Pressure**:
   - *Fix*: Migrate from V8 heap Buffer allocation to native C++ off-heap slab allocators or Rust/Hyper proxy engine (`backend/`).
3. **Bottleneck 3: Centralized Purge Broadcast**:
   - *Fix*: Replace in-process purge events with a distributed Redis Pub/Sub or Kafka invalidation bus.
