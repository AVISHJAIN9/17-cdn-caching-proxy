# Architecture Decision Records (ADR) Log

This table documents every major architectural design decision made in `17-cdn-caching-proxy`.

| Decision ID | Decision Topic | Chosen Option | Alternatives Considered | Deciding Factors | Trade-off Accepted | Revisit When |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ADR-001** | Core Runtime | Node.js Streams + TypeScript | Rust Hyper, Go net/http, Nginx C++ | Unified TypeScript codebase with Next.js dashboard; rapid iteration on RFC 9111 logic. | Slightly higher memory baseline than pure C++ or Rust. | Single-core throughput exceeds 100k RPS. |
| **ADR-002** | In-Memory Storage | Segmented Buffers (`MemoryStore`) | Redis 7, Memcached, SQLite | Eliminates 1ms network hop; delivers true sub-millisecond edge response times. | Cache memory is isolated per proxy instance. | Cluster exceeds 50 stateless proxy pods. |
| **ADR-003** | Thundering Herd | In-Memory `RequestCoalescer` | Redis Distributed Lock, RabbitMQ | Zero-latency coordination; instant stream fanout to all waiting sockets. | Leader socket failure requires follower re-election. | Multi-tier origin shield clustering required. |
| **ADR-004** | Purge Strategy | Inverted Tag Index (`PurgeIndex`) | URL scanning, Regex scan | O(1) tag lookup allows invalidating 1,000 items in < 5ms. | Tag index consumes additional RAM. | Unique tag cardinality exceeds 10,000,000. |
| **ADR-005** | Compression Engine | Native Node.js `zlib` | External Wasm codec, Origin compression | Zero external native bindings; streaming transforms with backpressure. | Brotli level 11 CPU intensive; capped at level 6. | Hardware compression accelerator cards available. |
| **ADR-006** | Telemetry Protocol | Prometheus 0.0.4 Text Format | StatsD, InfluxDB, Custom JSON | Standard ecosystem compatibility with Prometheus and Grafana. | Pull-based scrape model requires HTTP endpoint. | Real-time push metrics needed at 100k nodes. |
| **ADR-007** | Frontend Dashboard | Next.js 14 App Router + Recharts | Vite React SPA, Grafana dashboard | Self-contained, custom control UI with dynamic route and purge forms. | Node.js runtime needed for Next.js build. | Dedicated central multi-cluster UI built. |
