# Technical Debt, Known Gaps & Future Improvements

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
