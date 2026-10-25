# Architecture Decisions Confirmation List [CONFIRM WITH DEVELOPER]

The following design decisions and operational assumptions were deduced from the codebase and should be confirmed by the primary engineer:

| Item # | Topic | Deduced Design Choice | Location in Codebase | Rationale to Confirm |
| :--- | :--- | :--- | :--- | :--- |
| **C1** | Storage Tiering | Defaulting to in-memory `MemoryStore` with flat segment `DiskStore` fallback instead of Redis. | `src/cache/store.ts` | Selected to achieve true sub-millisecond lookups (< 0.1ms) without external network hops. |
| **C2** | Coalescing Policy | In-flight leader-follower stream fanout instead of queuing in Redis/RabbitMQ. | `src/proxy/coalesce.ts` | Eliminates distributed locking overhead; maximizes local proxy throughput. |
| **C3** | Purge Strategy | Synchronous purge for < 50 items; asynchronous worker queue for > 50 items. | `src/purge/api.ts:25` | Prevents event loop blocking during massive tenant or tag purge operations. |
| **C4** | AIML Tier Role | Tier A/B models strictly advisory; zero AI models placed on critical latency path. | `aiml/MODEL_CARD.md` | Ensures strict deterministic RFC 9111 correctness and avoids latency jitter. |
| **C5** | Compression Cap | Brotli compression level capped at 6 instead of 11. | `src/compression/codecs.ts` | Balances CPU consumption against byte savings during high-throughput edge proxying. |
