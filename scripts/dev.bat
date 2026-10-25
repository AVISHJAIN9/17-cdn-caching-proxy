@echo off
setlocal enabledelayedexpansion

echo ==========================================================
echo  Starting CDN Caching Proxy Localhost Environment (Win)...
echo ==========================================================

start "Origin 8001" cmd /c "set PORT=8001 && npx tsx scripts/demo-origin.ts"
start "Origin 8002" cmd /c "set PORT=8002 && npx tsx scripts/demo-origin.ts"
start "Origin 8003" cmd /c "set PORT=8003 && npx tsx scripts/demo-origin.ts"
start "Proxy 8080/9090" cmd /c "set PROXY_PORT=8080&& set ADMIN_PORT=9090&& npx tsx scripts/run-proxy.ts"
start "Frontend 3000" cmd /c "cd frontend && set PORT=3000 && npm run dev"

echo Waiting for readiness on ports 8001, 8002, 8003, 8080, 9090, 3000...
timeout /t 5 /nobreak >nul

echo ==========================================================
echo  CDN Caching Proxy Cluster is LIVE on Localhost
echo ==========================================================
echo  - Proxy Reverse Cache:     http://localhost:8080
echo  - Prometheus /metrics:     http://localhost:8080/metrics
echo  - Admin SPA Dashboard:     http://localhost:9090/admin
echo  - Admin REST API:          http://localhost:9090/admin/api/v1/overview
echo  - Next.js Frontend:        http://localhost:3000/dashboard
echo  - Origin 1 (Primary):      http://localhost:8001
echo  - Origin 2 (Secondary):    http://localhost:8002
echo  - Origin 3 (Backup):       http://localhost:8003
echo ==========================================================
echo Close individual command windows to stop processes.
