# Project Type Detection & Adaptation Track

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
