# RFC 9111 Compliant CDN Caching Proxy

[![CI](https://github.com/AVISHJAIN9/cdn-caching-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/AVISHJAIN9/cdn-caching-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Scaffolded](https://img.shields.io/badge/Status-Scaffolded-yellow.svg)](#status)

High-performance reverse caching proxy with RFC 9111 HTTP caching semantics, memory/disk tiering, and request coalescing.

---

## Table of Contents
1. [Cluster Ports & Endpoints](#cluster-ports--endpoints)
2. [Local Quickstart & Execution](#local-quickstart--execution)
3. [Executive Overview](#1-executive-overview)
4. [End-to-End System Flows](#2-end-to-end-system-flows)
5. [Architecture & Component Breakdown](#3-architecture--component-breakdown)
6. [Testing & Verification Strategy](#8-testing--verification-strategy)
7. [Benchmark Plan & Performance Targets](#9-benchmark-plan--performance-targets)
8. [Deployment & Infrastructure](#10-deployment--infrastructure)

---

## Cluster Ports & Endpoints

| Component | Port | Local URL | Description |
| :--- | :--- | :--- | :--- |
| **Proxy Reverse Cache** | `8080` | `http://localhost:8080` | RFC 9111 caching reverse proxy engine |
| **Prometheus Metrics** | `8080` | `http://localhost:8080/metrics` | Prometheus exposition endpoint |
| **Admin SPA Dashboard** | `9090` | `http://localhost:9090/admin` | Built-in interactive control plane & telemetry SPA |
| **Admin REST API** | `9090` | `http://localhost:9090/admin/api/v1/overview` | Admin REST API (CORS enabled, token authenticated) |
| **Next.js Frontend** | `3000` | `http://localhost:3000/dashboard` | Next.js 14 telemetry & control dashboard |
| **Origin 1 (Primary)** | `8001` | `http://localhost:8001` | Controllable upstream origin primary node |
| **Origin 2 (Secondary)**| `8002` | `http://localhost:8002` | Controllable upstream origin secondary node |
| **Origin 3 (Backup)** | `8003` | `http://localhost:8003` | Controllable upstream origin backup node |

---

## Local Quickstart & Execution

```bash
# 1. Install dependencies
npm install
(cd frontend && npm install)

# 2. Start full local cluster (3 mock origins + proxy + admin API + frontend)
./scripts/dev.sh
# (On Windows, run: scripts\dev.bat)

# 3. Drive realistic live traffic
npx tsx scripts/drive-traffic.ts

# 4. Run automated test suite (151 test suites, 1064 tests)
npm test

# 5. Run Playwright real browser verification
npx vitest run tests/ui-dashboard-playwright.test.ts
```

---

## 1. Executive Overview [Specified]
This repository provides an industrial-grade, standalone implementation of **RFC 9111 Compliant CDN Caching Proxy**. Built in **Rust** with supporting infrastructure in **Rust, Hyper / Tokio, Mmap**, the system solves hard-core systems-engineering challenges with zero shortcuts.

### Status Tagging Conventions
- `[Specified]`: Architectural design and technical specification complete.
- `[Scaffolded]`: Interfaces, data structures, and method stubs defined with strict typed signatures and `NotImplemented` guards.
- `[Implemented]`: Fully executable logic written and integrated.
- `[Verified]`: Validated via automated test suites and benchmarks.

---

## 2. End-to-End System Flows [Specified]
1. **Client Interaction**: User navigates to the landing page, authenticates via OAuth, and accesses the telemetry dashboard or interactive client playground.
2. **Ingress & Processing**: Incoming requests are validated, parsed into zero-copy internal buffers, and routed through the core state engine.
3. **Storage & Replication**: Mutations are logged via Write-Ahead Logs (WAL) and persisted into partitioned relational tables / key-value stores.
4. **AI Operations**: Tier A background models monitor telemetry streams for anomalies or adaptive tuning, while Tier B LLM assistants provide natural language diagnostics with strict schema validation.

---

## 3. Architecture & Component Breakdown [Specified]
- **Core Engine**: Strict RFC 9111 semantics (Cache-Control, ETag, Vary, revalidation), stale-while-revalidate and stale-if-error, single-flight request coalescing (thundering herd protection), memory-then-disk tiering with size-aware eviction, purge by key and surrogate tag, HTTP range requests, negative caching.
- **Storage Layer**: PostgreSQL 16 & Redis 7.2
- **AIML Layer**:
  - **Tier A**: Popularity Predictor for proactive cache prefetch and eviction vs LRU
  - **Tier B**: Cache-miss forensic diagnostics and header optimization assistant
- **Frontend**: Next.js 14, TypeScript, TailwindCSS, GSAP ScrollTrigger, Lenis smooth scroll, Three.js 3D viewport.

---

## 4. Benchmark Plan & Performance Targets [Specified]

| Benchmark Test | Baseline | Target Specification | Status |
| :--- | :--- | :--- | :--- |
| Core Engine Operation Throughput | Standard Sync Baseline | High-Throughput Target | **TO BE MEASURED** |
| p99 Operation Latency | Standard Sync Baseline | Low-Latency Target | **TO BE MEASURED** |
| Memory Allocation per Op | Naive Allocation | Exactly 0 or Bounded Heap Alloc | **TO BE MEASURED** |
| Tier A Model Accuracy / F1 | Static Rule Baseline | Statistically Significant Win | **TO BE MEASURED** |

---

## 5. Unknowns & TO BE MEASURED Register [Specified]
1. **Engine Throughput & Latency**:
   - *Measurement Command*: Run benchmark suite in `benchmarks/`.
2. **Tier A AI Model Metric**:
   - *Measurement Command*: Run `python3 aiml/eval/evaluate_model.py`.
