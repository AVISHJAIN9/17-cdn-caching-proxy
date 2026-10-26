# Stage 1: Build source
FROM node:20.18.0-alpine3.20 AS builder

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Production dependencies
FROM node:20.18.0-alpine3.20 AS prod-deps

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: Runtime image
FROM node:20.18.0-alpine3.20 AS runner

LABEL org.opencontainers.image.title="cdn-caching-proxy" \
      org.opencontainers.image.description="High-Performance RFC 9111 Distributed CDN Caching Proxy" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.authors="CDN Edge Engineering Team" \
      org.opencontainers.image.source="https://github.com/example/cdn-caching-proxy"

ENV NODE_ENV=production \
    PORT=8080 \
    ADMIN_PORT=9090 \
    CACHE_DIR=/var/cache/cdn

WORKDIR /app

# Create cache and tmp directories with proper ownership for non-root user
RUN mkdir -p /var/cache/cdn /tmp && \
    chown -R node:node /app /var/cache/cdn /tmp

COPY --from=prod-deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --chown=node:node package*.json ./

USER node

EXPOSE 8080 8443 9090

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.get('http://127.0.0.1:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1));"

STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "dist/src/proxy/index.js"]
