#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=========================================================="
echo " Starting CDN Caching Proxy Localhost Environment..."
echo "=========================================================="

# PID tracking for clean teardown
PIDS=()

cleanup() {
  echo ""
  echo "Shutting down all CDN cluster processes..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "Cluster stopped cleanly."
}
trap cleanup EXIT INT TERM

# 1. Start 3 Mock Origin Servers
echo "[1/3] Starting Controllable Mock Origins (8001, 8002, 8003)..."
PORT=8001 npx tsx scripts/demo-origin.ts > /tmp/cdn_origin_8001.log 2>&1 &
PIDS+=($!)

PORT=8002 npx tsx scripts/demo-origin.ts > /tmp/cdn_origin_8002.log 2>&1 &
PIDS+=($!)

PORT=8003 npx tsx scripts/demo-origin.ts > /tmp/cdn_origin_8003.log 2>&1 &
PIDS+=($!)

# 2. Start Proxy & Admin Server
echo "[2/3] Starting Proxy Backend (:8080) and Admin API/Dashboard (:9090)..."
PROXY_PORT=8080 ADMIN_PORT=9090 npx tsx scripts/run-proxy.ts > /tmp/cdn_proxy.log 2>&1 &
PIDS+=($!)

# 3. Start Next.js Frontend Dashboard
echo "[3/3] Starting Next.js Telemetry Frontend (:3000)..."
(cd frontend && PORT=3000 npm run dev) > /tmp/cdn_frontend.log 2>&1 &
PIDS+=($!)

# Wait for Readiness
echo "Waiting for services to become healthy..."
wait_for_url() {
  local url="$1"
  local name="$2"
  local max_retries=60
  local count=0
  until curl -sf "$url" > /dev/null 2>&1; do
    count=$((count + 1))
    if [ "$count" -ge "$max_retries" ]; then
      echo "ERROR: Timed out waiting for $name at $url"
      exit 1
    fi
    sleep 0.5
  done
  echo "  ✓ $name is ready ($url)"
}

wait_for_url "http://127.0.0.1:8001/__stats" "Mock Origin Primary (8001)"
wait_for_url "http://127.0.0.1:8002/__stats" "Mock Origin Secondary (8002)"
wait_for_url "http://127.0.0.1:8003/__stats" "Mock Origin Backup (8003)"
wait_for_url "http://127.0.0.1:8080/__cache/stats" "Proxy Engine (8080)"
wait_for_url "http://127.0.0.1:9090/admin" "Admin API & Dashboard (9090)"
wait_for_url "http://127.0.0.1:3000/dashboard" "Next.js Frontend (3000)"

echo "=========================================================="
echo " CDN Caching Proxy Cluster is LIVE on Localhost"
echo "=========================================================="
echo " • Proxy Reverse Cache:     http://localhost:8080"
echo " • Prometheus /metrics:     http://localhost:8080/metrics"
echo " • Admin SPA Dashboard:     http://localhost:9090/admin"
echo " • Admin REST API:          http://localhost:9090/admin/api/v1/overview"
echo " • Next.js Frontend:        http://localhost:3000/dashboard"
echo " • Origin 1 (Primary):      http://localhost:8001"
echo " • Origin 2 (Secondary):    http://localhost:8002"
echo " • Origin 3 (Backup):       http://localhost:8003"
echo "=========================================================="
echo "Press Ctrl+C to shut down all services."

# Wait indefinitely on child processes
wait
