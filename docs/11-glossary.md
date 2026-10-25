# Technical Glossary & Concepts Reference

A comprehensive dictionary of systems engineering, HTTP caching, and networking terminology used in `17-cdn-caching-proxy`.

---

## Caching & Networking Terms

- **RFC 9111**: The modern IETF standard specification governing HTTP Caching semantics, replacing RFC 7234.
- **Request Coalescing (Single-Flight)**: An architectural pattern that intercepts multiple concurrent requests for the same uncached resource and collapses them into a single upstream request, protecting origins from thundering herd stampedes.
- **Surrogate-Key (Cache-Tag)**: A response header containing space-separated identifiers that tag cached representations, enabling bulk invalidation of related resources in O(1) time.
- **Stale-While-Revalidate (RFC 5861)**: A Cache-Control directive instructing the proxy to serve an expired cached entry immediately to the client while asynchronously dispatching a background request to fetch fresh content.
- **Stale-If-Error (RFC 5861)**: A Cache-Control directive allowing the proxy to serve an expired cached response if the upstream origin returns a 5xx error or network timeout.
- **Canonical Cache Key**: A normalized SHA-256 hash derived from the request URL, query parameters (sorted deterministically), and secondary keys from `Vary` headers.
- **Segmented LRU (SLRU)**: An eviction algorithm that divides cache space into probationary and protected segments, requiring an asset to be accessed at least twice before entering the protected tier.
- **Ketama Consistent Hashing**: A deterministic hashing algorithm that maps cache keys and server nodes onto a 32-bit ring with virtual nodes, minimizing key migration during node additions or removals.
- **Zero-Copy Stream Piping**: Transferring raw byte chunks from an ingress socket to an egress socket without deserializing the payload into intermediate application memory.
- **Content Negotiation**: The HTTP mechanism (`Accept-Encoding` vs `Content-Encoding`) allowing clients and proxies to negotiate optimal data formats such as Brotli or Gzip.
