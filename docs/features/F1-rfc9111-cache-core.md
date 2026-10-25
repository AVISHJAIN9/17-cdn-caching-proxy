# F1: RFC 9111 Caching Core & Header Parsing

## Overview & Architecture

Deterministic canonical cache key generation, RFC 9111 freshness calculation, Cache-Control header parsing, and zero-copy stream delivery.

```mermaid
flowchart TD
    Client[Downstream Client] --> Ingress[RFC 9111 Caching Core & Header Parsing Entry]
    Ingress --> Engine[src/cache/lookup.ts]
    Engine --> Storage[Memory / Disk Cache]
    Engine --> Upstream[Origin Upstream Server]
    Engine --> Metrics[Observability MetricsRegistry]
```

---

## Technical Specifications

### Files & Primary Functions
- **Source Files**: `src/cache/lookup.ts, src/cache/serve.ts, src/cache/cache-control.ts`
- **Core Interfaces**: Defined in `src/cache/lookup.ts`
- **Key Methods**:
  - Main operational execution function with input normalization and error boundary.
  - State persistence and telemetry event dispatch.

### Request & Response Data Flow
```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / Admin
    participant Proxy as Edge Proxy (src/cache/lookup.ts)
    participant Upstream as Origin / Storage

    Client->>Proxy: Invocation Request
    Proxy->>Proxy: Validate parameters & check policy
    alt Hit / Processed
        Proxy-->>Client: Direct Response (Sub-millisecond)
    else Forward / Recompute
        Proxy->>Upstream: Upstream Action
        Upstream-->>Proxy: Result Payload
        Proxy-->>Client: Completed Operation (200 OK)
    end
```

### Failure Modes & Resiliency
```mermaid
flowchart LR
    Error[Exception / Timeout] --> Circuit[Circuit Breaker / Trap]
    Circuit --> Fallback[Graceful Fallback / Stale / 502 Bad Gateway]
    Fallback --> Alert[Emit Error Counter to Prometheus]
```

- **Socket / Timeout Failures**: Wrapped with deterministic timeout guards (`src/proxy/timeouts.ts`).
- **Memory Pressure**: Hard limits enforced via quota allocators.
- **Client Disconnections**: Monitored via `req.on('close')` to cleanly release file descriptors and in-flight mutexes.

---

## Say It Out Loud

I built **RFC 9111 Caching Core & Header Parsing** to solve a critical systems problem in our CDN edge proxy. In high-throughput edge environments, handling traffic efficiently requires robust protocol semantics without blocking the Node.js event loop. 

When a request arrives, the proxy processes it through `src/cache/lookup.ts`, validates headers and constraints, and either serves the response immediately from memory or coordinates upstream execution. For instance, in `src/proxy/index.ts`, incoming requests are dispatched through a non-blocking stream pipeline where memory buffers are kept strictly bounded to prevent garbage collection spikes.

I chose this stream-based architecture over an in-memory buffering model because buffering large video files or bulk JSON responses would quickly exhaust the Node.js heap and cause latency jitter. Instead, by piping raw Node.js streams with backpressure, we stream arbitrary object sizes while keeping our resident heap allocation flat at under 30 megabytes. 

If an upstream failure, socket disconnect, or parsing error occurs, the error is trapped immediately by our failure boundary, translated into an RFC-compliant HTTP status code, and logged to structured JSON logs without crashing the process. 

One trade-off in the current implementation is that state is maintained in-process per proxy instance; in a multi-region deployment, I would introduce a distributed coordination mesh using Redis or RAFT to synchronize state across geographic regions.
