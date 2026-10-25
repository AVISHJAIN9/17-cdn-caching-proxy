# Edge Security Architecture & OWASP Top 10 Audit

## 1. OWASP Top 10 Mapping & Defenses

| OWASP Vulnerability | Risk in CDN Caching Proxy | Implemented Defense in Code | Status |
| :--- | :--- | :--- | :--- |
| **A01: Broken Access Control** | Unauthorized cache purging or origin draining. | Token scope validation in `src/purge/api.ts:60` enforcing `purge:url`, `purge:tag` permissions. | **Implemented** |
| **A02: Cryptographic Failures** | Eavesdropping on edge traffic or certificate forgery. | Dynamic TLS termination (`src/tls/cert-watcher.ts`) supporting TLS 1.3 and strong ciphers. | **Implemented** |
| **A03: Injection** | Header injection or cache poisoning via unescaped delimiters. | Canonical URL normalization (`src/proxy/normalize-url.ts`) and strict header validation. | **Implemented** |
| **A04: Insecure Design** | Thundering herd DDoS attacking upstream origin. | Request coalescing (`src/proxy/coalesce.ts`) collapsing misses into a single flight. | **Implemented** |
| **A05: Security Misconfiguration**| Verbose stack traces exposed to public clients. | Centralized error masking in `src/proxy/error-response.ts` hiding internal stack traces. | **Implemented** |
| **A06: Vulnerable Components**| Outdated third-party npm packages. | Minimal dependency tree (only `zod` in production dependencies). | **Implemented** |
| **A07: Identification & Auth** | Spoofed admin API calls or unauthorized proxy use. | Scoped Bearer tokens for admin API and JWT/OIDC validation for edge ingress. | **Implemented** |
| **A08: Software & Data Integrity**| Tampering with cache invalidation audit logs. | Cryptographic SHA-256 hash-chained audit trail (`src/purge/audit.ts`). | **Implemented** |
| **A09: Logging & Monitoring** | Silent failures during origin outages or attack traffic. | Structured JSON request logging and Prometheus error counters (`src/observability/`). | **Implemented** |
| **A10: SSRF** | Attacker forcing proxy to request internal cloud metadata. | SSRF destination validator (`src/security/origin-access.ts`) blocking loopback and private IPs. | **Implemented** |

---

## 2. Specialized CDN Edge Defenses

### 2.1 Cache Poisoning Prevention
- **Canonical Key Generation**: Query parameters are deterministically sorted (`?a=1&b=2` vs `?b=2&a=1`), scheme and hostname are lowercased, and duplicate slashes stripped.
- **Vary Header Isolation**: Cached variants are keyed by secondary headers (`Vary: Accept-Encoding, User-Agent`). An attacker cannot poison a Gzip response into a Brotli client.

### 2.2 Decompression Bomb Protection
- In `src/compression/codecs.ts`, the `DecompressionBombLimiter` transform stream tracks decompressed bytes in real-time. If an uncompressed stream exceeds 100 MB, the stream is aborted with HTTP 502 to prevent memory exhaustion.
