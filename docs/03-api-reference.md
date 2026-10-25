# API Reference: Edge Proxy & Admin Control Plane

This document specifies all HTTP interfaces exposed by `17-cdn-caching-proxy`.

---

## 1. Reverse Proxy Ingress (Port 8080)

### 1.1 Reverse Caching Pipeline
- **Method & Path**: `GET /*`, `HEAD /*`
- **Purpose**: Intercepts downstream requests, serves cached responses, or proxies to origin.
- **Headers**:
  - `Host` *(required)*: Validated against allowed hosts.
  - `Accept-Encoding`: Content negotiation (`br`, `gzip`, `zstd`).
  - `If-None-Match`: Client conditional ETag for 304 revalidation.
  - `Range`: RFC 7233 byte-range request (`bytes=0-1024`).
- **Response Headers Added**:
  - `X-Cache`: `HIT` | `MISS` | `BYPASS` | `STALE`
  - `Age`: Calculated object age in seconds per RFC 9111.
  - `Cache-Control`: Cached directives or origin pass-through.
  - `traceparent`: W3C distributed tracing context.
- **Status Codes**:
  - `200 OK`: Resource found (fresh cache hit or origin response).
  - `206 Partial Content`: Byte-range slice fulfilled.
  - `304 Not Modified`: Cached resource validated against client validator.
  - `502 Bad Gateway`: Upstream origin unreachable or circuit breaker open.
  - `504 Gateway Timeout`: Upstream origin timed out.

### 1.2 Prometheus Metrics Exposition
- **Method & Path**: `GET /metrics`
- **Auth**: None
- **Response Format**: `text/plain; version=0.0.4; charset=utf-8`
- **Sample Output**:
  ```
  # HELP cdn_cache_requests_total Total requests processed by the CDN proxy
  # TYPE cdn_cache_requests_total counter
  cdn_cache_requests_total{cache_status="hit"} 950
  cdn_cache_requests_total{cache_status="miss"} 50
  cdn_cache_requests_total{cache_status="bypass"} 5

  # HELP cdn_cache_hit_ratio Current cache request hit ratio
  # TYPE cdn_cache_hit_ratio gauge
  cdn_cache_hit_ratio 0.9500

  # HELP cdn_origin_request_duration_seconds Origin latency histogram
  # TYPE cdn_origin_request_duration_seconds histogram
  cdn_origin_request_duration_seconds_bucket{le="0.05"} 45
  cdn_origin_request_duration_seconds_bucket{le="0.25"} 49
  cdn_origin_request_duration_seconds_bucket{le="+Inf"} 50
  ```

---

## 2. Admin Control Plane REST API (Port 9090)

All `/admin/api/*` endpoints require authentication via:
`Authorization: Bearer <ADMIN_TOKEN>` (default: `admin-secret`).

### 2.1 Cluster Overview
- **Endpoint**: `GET /admin/api/v1/overview`
- **Response 200 OK**:
  ```json
  {
    "objectsCount": 1420,
    "totalBytes": 48190240,
    "hitRatio": 0.9482,
    "byteHitRatio": 0.9715
  }
  ```

### 2.2 Time-Series History
- **Endpoint**: `GET /admin/api/v1/timeseries/:metric`
- **Response 200 OK**:
  ```json
  {
    "points": [
      {
        "timestamp": 1729850000000,
        "hitRatio": 0.95,
        "requestsPerSec": 450,
        "originLatencyP95": 14.2
      }
    ]
  }
  ```

### 2.3 Instant Cache Invalidation (Purge API)
- **Endpoint**: `POST /admin/api/v1/purge`
- **Request Body (Tag Purge)**:
  ```json
  {
    "target": "tag",
    "value": "products-sale",
    "soft": false
  }
  ```
- **Request Body (URL Purge)**:
  ```json
  {
    "target": "url",
    "value": "https://cdn.example.com/images/hero.webp"
  }
  ```
- **Response 200 OK (Sync Execution)**:
  ```json
  {
    "success": true,
    "purgedCount": 84,
    "executionTimeMs": 2.4,
    "auditRecordId": "b8a9f02c4d..."
  }
  ```
- **Response 202 Accepted (Async Execution)**:
  ```json
  {
    "success": true,
    "jobId": "purge-job-891",
    "status": "queued"
  }
  ```

### 2.4 Origin Health & Drain Management
- **List Origins**: `GET /admin/api/v1/origins`
- **Drain Origin**: `POST /admin/api/v1/origins/:id/drain`
- **Enable Origin**: `POST /admin/api/v1/origins/:id/enable`
