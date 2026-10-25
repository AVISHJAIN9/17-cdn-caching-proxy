---
layout: home

hero:
  name: "CDN Caching Proxy"
  text: "RFC 9111 Compliant Edge Cache"
  tagline: "Industrial-grade reverse caching edge proxy in TypeScript and Node.js streams."
  actions:
    - theme: brand
      text: Project Overview
      link: /00a-project-analysis
    - theme: alt
      text: Interview Q&A (150+)
      link: /09-interview-qa
    - theme: alt
      text: Master Checklist (275)
      link: /13-master-checklist

features:
  - title: "RFC 9111 Compliant"
    details: "Strict Cache-Control, ETag, Age, and conditional 304 revalidation rules."
    link: /01-features
  - title: "Single-Flight Coalescing"
    details: "Eliminates thundering herds by collapsing 500+ misses into 1 origin fetch."
    link: /features/F2-request-collapsing
  - title: "Sub-5ms Tag Purge"
    details: "Surrogate-Key inverted tag indexing backed by a SHA-256 audit log."
    link: /features/F6-surrogate-key-purge
  - title: "151 Test Suites Passing"
    details: "1,064 automated assertions covering memory leaks and protocol edge cases."
    link: /08-quality-and-ops
---
