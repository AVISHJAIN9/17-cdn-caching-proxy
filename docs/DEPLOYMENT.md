# Deployment Guide: Edge Reverse Caching Proxy

## Hosting & Infrastructure
- **Live URL**: [https://aj-cdn-caching-proxy.onrender.com/health](https://aj-cdn-caching-proxy.onrender.com/health)
- **Hosting Environment**: Render Free-Tier PaaS

*Note on Cold Starts: Free-tier Render instances spin down after 15 minutes of inactivity. Initial inbound requests may experience a 30-50 second cold-start delay while the container boots.*

## Containerization
A `Dockerfile` is provided for containerized multi-stage builds.
