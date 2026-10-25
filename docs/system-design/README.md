# System Design Deep Dive: CDN Caching Proxy

This section provides comprehensive system design analyses across all 17 core distributed systems dimensions.

---

## System Design Navigation Index

| Topic # | Chapter Title | Core Architectural Focus |
| :--- | :--- | :--- |
| **14.1** | [Requirements & Capacity Estimation](./14.1-requirements-and-estimation.md) | Capacity arithmetic, RPS sizing, bandwidth offload calculations. |
| **14.2** | [Architecture Styles](./14.2-architecture-styles.md) | Reverse proxy edge architecture and layered stream processing. |
| **14.3** | [Networking & Communication](./14.3-networking-and-communication.md) | Keep-alive socket pools, TLS termination, and stream backpressure. |
| **14.4** | [Load Balancing & Scaling](./14.4-load-balancing-and-scaling.md) | Ketama consistent hash rings, origin pool weights, and failover. |
| **14.5** | [Databases & Storage Architecture](./14.5-databases-and-storage.md) | In-memory segment allocator backed by disk stores with compaction. |
| **14.6** | [Deep Caching Architecture](./14.6-caching.md) | RFC 9111 rules, single-flight request coalescing, and stale serving. |
| **14.7** | [Messaging & Queues](./14.7-messaging-and-queues.md) | Asynchronous purge worker queue and dead-letter retries. |
| **14.8** | [Consistency & Concurrency](./14.8-consistency-and-concurrency.md) | Cache coherency, tag purge atomicity, and Vary variant isolation. |
| **14.9** | [Reliability & Resilience](./14.9-reliability-and-resilience.md) | Circuit breakers, active synthetic probes, and stale-if-error fallback. |
| **14.10** | [API Design & Rate Limiting](./14.10-api-design-and-rate-limiting.md) | Admin REST API, Bearer token auth, CORS, and tenant quotas. |
| **14.11** | [Security Architecture](./14.11-security-architecture.md) | Edge WAF, CIDR IP filtering, Host verification, and SSRF defense. |
| **14.12** | [Search & AI Architecture](./14.12-search-and-ai-architecture.md) | Inverted tag index and Tier A/B predictive prefetch AI models. |
| **14.13** | [Real-Time Systems & Telemetry](./14.13-real-time-systems.md) | 1-second polling time-series metrics and live decision ring buffer. |
| **14.14** | [Observability & Operations](./14.14-observability-and-operations.md) | Prometheus metrics, W3C traceparent propagation, and structured logs. |
| **14.15** | [Performance Engineering](./14.15-performance-engineering.md) | Zero-copy stream piping, forced GC memory checks, and CPU profiling. |
| **14.16** | [Cost & Architectural Trade-Offs](./14.16-cost-and-trade-offs.md) | Egress cloud bandwidth savings vs edge memory hosting expenses. |
| **14.17** | [Classic System Design Questions](./14.17-classic-system-design.md) | Scaling to 100x, media streaming, notifications, and rate limiters. |
| **ADR** | [Architecture Decision Records (ADR)](./decisions.md) | Master log of all architectural decisions and accepted trade-offs. |
