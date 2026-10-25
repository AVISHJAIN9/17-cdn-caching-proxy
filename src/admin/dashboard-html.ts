/**
 * Standalone, zero-external-dependency CDN operations dashboard.
 * Pure HTML5/CSS3/ES6 with dynamic inline SVG charting, interactive control APIs,
 * live polling of real backend endpoints, and strict CSP nonce support.
 */
export function renderDashboardHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CDN Caching Proxy - Operations Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --border: #334155;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --text: #0f172a;
        --text-muted: #64748b;
        --primary: #0284c7;
        --success: #059669;
        --warning: #d97706;
        --danger: #dc2626;
        --border: #e2e8f0;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      gap: 12px;
    }
    .logo { font-size: 1.25rem; font-weight: 700; color: var(--primary); }
    .header-controls { display: flex; align-items: center; gap: 12px; font-size: 0.875rem; }
    .header-controls input {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 0.875rem;
    }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 24px; }
    nav button {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      font-size: 0.875rem;
      transition: background 0.15s, border-color 0.15s;
    }
    nav button:hover { border-color: var(--primary); }
    nav button.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
    }
    main { padding: 0 24px 32px 24px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .metric-title { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
    .metric-val { font-size: 1.75rem; font-weight: 700; margin-top: 8px; }
    .chart-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .chart-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    svg.chart { width: 100%; height: 160px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.875rem; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-success { background: rgba(52, 211, 153, 0.2); color: var(--success); }
    .badge-danger { background: rgba(248, 113, 113, 0.2); color: var(--danger); }
    .badge-warning { background: rgba(251, 191, 36, 0.2); color: var(--warning); }
    .btn {
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      border: none;
      font-size: 0.8rem;
    }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-danger { background: var(--danger); color: #fff; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px; }
    .form-group input, .form-group select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 0.875rem;
    }
    .banner { padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 0.875rem; display: none; }
    .banner-success { background: rgba(52, 211, 153, 0.2); color: var(--success); border: 1px solid var(--success); }
    .banner-error { background: rgba(248, 113, 113, 0.2); color: var(--danger); border: 1px solid var(--danger); }
  </style>
</head>
<body>
  <header>
    <div class="logo">⚡ CDN Caching Proxy Admin</div>
    <div class="header-controls">
      <span id="header-status">Status: Connecting...</span>
      <span>| Token:</span>
      <input type="password" id="admin-token" value="admin-secret" placeholder="Enter admin token">
    </div>
  </header>

  <nav id="nav-tabs">
    <button class="active" data-tab="overview">Overview</button>
    <button data-tab="traffic">Traffic & Hit Ratio</button>
    <button data-tab="latency">Origin Latency & Health</button>
    <button data-tab="storage">Cache Size & Eviction</button>
    <button data-tab="routes">Route Configuration</button>
    <button data-tab="policies">Cache Policy</button>
    <button data-tab="purge">Purge System</button>
    <button data-tab="tenants">Tenants</button>
    <button data-tab="inspect">Request Inspection</button>
  </nav>

  <main id="content">
    <div id="alert-banner" class="banner"></div>

    <!-- 1. OVERVIEW TAB -->
    <div id="tab-overview" class="tab-content active">
      <div class="grid">
        <div class="card">
          <div class="metric-title">Cache Hit Ratio</div>
          <div class="metric-val" id="metric-hit-ratio">0.0%</div>
        </div>
        <div class="card">
          <div class="metric-title">Byte Hit Ratio</div>
          <div class="metric-val" id="metric-byte-hit-ratio">0.0%</div>
        </div>
        <div class="card">
          <div class="metric-title">Cached Objects</div>
          <div class="metric-val" id="metric-objects">0</div>
        </div>
        <div class="card">
          <div class="metric-title">Stored Bytes</div>
          <div class="metric-val" id="metric-bytes">0 B</div>
        </div>
        <div class="card">
          <div class="metric-title">Server Uptime</div>
          <div class="metric-val" id="metric-uptime">0s</div>
        </div>
        <div class="card">
          <div class="metric-title">Active Node</div>
          <div class="metric-val" id="metric-node">edge-1</div>
        </div>
      </div>
    </div>

    <!-- 2. TRAFFIC & HIT RATIO TAB -->
    <div id="tab-traffic" class="tab-content">
      <div class="chart-container">
        <div class="chart-title">Hit Ratio Over Time</div>
        <svg class="chart" id="chart-hit-ratio" viewBox="0 0 500 150">
          <text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">Loading real time-series data...</text>
        </svg>
      </div>
      <div class="chart-container">
        <div class="chart-title">Traffic (Requests / sec)</div>
        <svg class="chart" id="chart-traffic" viewBox="0 0 500 150">
          <text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">Loading real time-series data...</text>
        </svg>
      </div>
    </div>

    <!-- 3. ORIGIN LATENCY & HEALTH TAB -->
    <div id="tab-latency" class="tab-content">
      <div class="chart-container">
        <div class="chart-title">Origin Latency (p50 / p95 / p99)</div>
        <svg class="chart" id="chart-latency" viewBox="0 0 500 150">
          <text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">Loading real latency distribution...</text>
        </svg>
      </div>
      <div class="card">
        <div class="chart-title">Origins Status & Traffic Drain Control</div>
        <table id="table-origins">
          <thead>
            <tr>
              <th>Origin ID</th>
              <th>Status</th>
              <th>Circuit State</th>
              <th>Weight</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="5">Loading origin pools...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 4. CACHE SIZE & EVICTION TAB -->
    <div id="tab-storage" class="tab-content">
      <div class="chart-container">
        <div class="chart-title">Cache Storage & Tier Utilization</div>
        <svg class="chart" id="chart-cache-size" viewBox="0 0 500 150">
          <text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">Loading cache size history...</text>
        </svg>
      </div>
      <div class="chart-container">
        <div class="chart-title">Evictions per Second (LRU / LFU / TTL / Size)</div>
        <svg class="chart" id="chart-evictions" viewBox="0 0 500 150">
          <text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">Loading eviction telemetry...</text>
        </svg>
      </div>
    </div>

    <!-- 5. ROUTE CONFIGURATION TAB -->
    <div id="tab-routes" class="tab-content">
      <div class="card" style="margin-bottom: 16px;">
        <div class="chart-title">Add / Update Routing Rule</div>
        <div style="display: grid; grid-template-columns: 2fr 2fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Path Pattern</label>
            <input type="text" id="route-path" placeholder="/api/v1/*">
          </div>
          <div class="form-group">
            <label>Target Origin / Pool</label>
            <input type="text" id="route-origin" placeholder="origin-primary">
          </div>
          <div class="form-group" style="display: flex; align-items: flex-end;">
            <button class="btn btn-primary" id="btn-save-route" style="width: 100%; height: 38px;">Apply Route</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="chart-title">Active Routes (<span id="route-version">v1</span>)</div>
        <table id="table-routes">
          <thead>
            <tr><th>Path Pattern</th><th>Target Origin</th><th>Priority</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="3">Loading active routes...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 6. CACHE POLICY TAB -->
    <div id="tab-policies" class="tab-content">
      <div class="card" style="margin-bottom: 16px;">
        <div class="chart-title">Effective Cache Policy Resolver</div>
        <div style="display: grid; grid-template-columns: 3fr 2fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Target Request URL</label>
            <input type="text" id="policy-url" value="/catalog/items/42">
          </div>
          <div class="form-group">
            <label>Tenant ID</label>
            <input type="text" id="policy-tenant" value="default">
          </div>
          <div class="form-group" style="display: flex; align-items: flex-end;">
            <button class="btn btn-primary" id="btn-resolve-policy" style="width: 100%; height: 38px;">Resolve</button>
          </div>
        </div>
        <div id="policy-result" style="margin-top: 12px; font-family: monospace; font-size: 0.85rem; background: var(--bg); padding: 12px; border-radius: 4px;">
          Click "Resolve" to inspect winning policy rules.
        </div>
      </div>
    </div>

    <!-- 7. PURGE SYSTEM TAB -->
    <div id="tab-purge" class="tab-content">
      <div class="card" style="margin-bottom: 16px;">
        <div class="chart-title">Execute Cache Invalidation</div>
        <div style="display: grid; grid-template-columns: 1fr 3fr 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Scope</label>
            <select id="purge-type">
              <option value="url">Single URL</option>
              <option value="prefix">Path Prefix</option>
              <option value="tag">Cache Tag</option>
              <option value="host">Host</option>
              <option value="tenant">Tenant</option>
            </select>
          </div>
          <div class="form-group">
            <label>Target Pattern</label>
            <input type="text" id="purge-target" placeholder="/images/logo.png">
          </div>
          <div class="form-group" style="display: flex; align-items: center; margin-top: 18px;">
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
              <input type="checkbox" id="purge-soft" style="width: auto;"> Soft Purge
            </label>
          </div>
          <div class="form-group" style="display: flex; align-items: flex-end;">
            <button class="btn btn-danger" id="btn-submit-purge" style="width: 100%; height: 38px;">Execute Purge</button>
          </div>
        </div>
        <div id="purge-output" style="margin-top: 8px; font-size: 0.85rem;"></div>
      </div>
      <div class="card">
        <div class="chart-title">Tamper-Evident Purge Audit Trail</div>
        <table id="table-audit">
          <thead>
            <tr><th>Timestamp</th><th>Actor</th><th>Scope</th><th>Target</th><th>Outcome</th><th>SHA-256 Hash</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="6">Loading audit records...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 8. TENANTS TAB -->
    <div id="tab-tenants" class="tab-content">
      <div class="card">
        <div class="chart-title">Tenant Quotas & Namespace Isolation</div>
        <table id="table-tenants">
          <thead>
            <tr><th>Tenant ID</th><th>Hit Ratio</th><th>Bytes Stored</th><th>Quota Limit</th><th>Total Requests</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="5">Loading tenant records...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 9. REQUEST INSPECTION TAB -->
    <div id="tab-inspect" class="tab-content">
      <div class="card">
        <div class="chart-title">Live Request Decisions Ring Buffer</div>
        <table id="table-inspect">
          <thead>
            <tr><th>Time</th><th>URL</th><th>Decision</th><th>Cache Key</th><th>Served By</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="5">Loading recent decisions...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script nonce="${nonce}">
    function escapeHtml(str) {
      if (typeof str !== 'string') return String(str || '');
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatBytes(bytes) {
      if (!bytes || isNaN(bytes)) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function getToken() {
      const el = document.getElementById('admin-token');
      return el ? el.value.trim() : 'admin-secret';
    }

    function getAuthHeaders() {
      return {
        'Authorization': 'Bearer ' + getToken(),
        'Content-Type': 'application/json'
      };
    }

    // Tab switching
    document.getElementById('nav-tabs').addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const tab = e.target.getAttribute('data-tab');
      document.querySelectorAll('#nav-tabs button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const activeContent = document.getElementById('tab-' + tab);
      if (activeContent) activeContent.classList.add('active');
    });

    function showAlert(msg, isError) {
      const b = document.getElementById('alert-banner');
      b.className = 'banner ' + (isError ? 'banner-error' : 'banner-success');
      b.textContent = msg;
      b.style.display = 'block';
      setTimeout(() => { b.style.display = 'none'; }, 5000);
    }

    function drawLineChart(svgId, points, valExtractor, strokeColor, fillColor) {
      const svg = document.getElementById(svgId);
      if (!svg) return;
      if (!points || points.length === 0) {
        svg.innerHTML = '<text x="250" y="75" fill="var(--text-muted)" text-anchor="middle">No time-series data yet (idle traffic)</text>';
        return;
      }

      const values = points.map(valExtractor);
      const min = Math.min(...values, 0);
      const max = Math.max(...values, 1);
      const width = 500;
      const height = 150;
      const padding = 20;

      const coords = values.map((val, idx) => {
        const x = padding + (idx / Math.max(values.length - 1, 1)) * (width - 2 * padding);
        const y = height - padding - ((val - min) / (max - min)) * (height - 2 * padding);
        return [x, y];
      });

      const polyPoints = coords.map(c => c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
      let html = '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="var(--border)" stroke-width="1" />';
      if (fillColor) {
        const areaPoints = polyPoints + ' ' + (width - padding) + ',' + (height - padding) + ' ' + padding + ',' + (height - padding);
        html += '<polygon points="' + areaPoints + '" fill="' + fillColor + '" />';
      }
      html += '<polyline points="' + polyPoints + '" fill="none" stroke="' + strokeColor + '" stroke-width="2.5" stroke-linecap="round" />';
      svg.innerHTML = html;
    }

    async function pollLiveTelemetry() {
      const headers = getAuthHeaders();
      try {
        // Status & Overview
        const [statusRes, overviewRes] = await Promise.all([
          fetch('/admin/api/v1/status', { headers }),
          fetch('/admin/api/v1/overview', { headers })
        ]);

        if (statusRes.ok) {
          const status = await statusRes.json();
          document.getElementById('header-status').textContent = 'Node: ' + status.nodeId + ' | ' + status.status;
          document.getElementById('metric-node').textContent = status.nodeId;
          document.getElementById('metric-uptime').textContent = status.uptimeSeconds + 's';
        }

        if (overviewRes.ok) {
          const ov = await overviewRes.json();
          document.getElementById('metric-hit-ratio').textContent = (ov.hitRatio * 100).toFixed(1) + '%';
          document.getElementById('metric-byte-hit-ratio').textContent = (ov.byteHitRatio * 100).toFixed(1) + '%';
          document.getElementById('metric-objects').textContent = ov.objectsCount.toLocaleString();
          document.getElementById('metric-bytes').textContent = formatBytes(ov.totalBytes);
        }

        // Timeseries
        const [trafficRes, hitRatioRes, latencyRes, sizeRes, evictRes] = await Promise.all([
          fetch('/admin/api/v1/timeseries/traffic', { headers }),
          fetch('/admin/api/v1/timeseries/hit-ratio', { headers }),
          fetch('/admin/api/v1/timeseries/origin-latency', { headers }),
          fetch('/admin/api/v1/timeseries/cache-size', { headers }),
          fetch('/admin/api/v1/timeseries/evictions', { headers })
        ]);

        if (trafficRes.ok) {
          const d = await trafficRes.json();
          drawLineChart('chart-traffic', d.points, p => p.requestsPerSec || 0, 'var(--primary)', 'rgba(56, 189, 248, 0.2)');
        }
        if (hitRatioRes.ok) {
          const d = await hitRatioRes.json();
          drawLineChart('chart-hit-ratio', d.points, p => p.hitRatio || 0, 'var(--success)');
        }
        if (latencyRes.ok) {
          const d = await latencyRes.json();
          drawLineChart('chart-latency', d.points, p => p.latencyMs || 0, 'var(--warning)');
        }
        if (sizeRes.ok) {
          const d = await sizeRes.json();
          drawLineChart('chart-cache-size', d.points, p => p.bytes || 0, 'var(--primary)');
        }
        if (evictRes.ok) {
          const d = await evictRes.json();
          drawLineChart('chart-evictions', d.points, p => p.evictionsPerSec || 0, 'var(--danger)');
        }

        // Origins
        const originsRes = await fetch('/admin/api/v1/origins', { headers });
        if (originsRes.ok) {
          const data = await originsRes.json();
          const tbody = document.querySelector('#table-origins tbody');
          tbody.innerHTML = (data.origins || []).map(o => {
            const isDrained = Boolean(o.drained);
            const badgeClass = isDrained ? 'badge-danger' : 'badge-success';
            const badgeText = isDrained ? 'DRAINED' : 'ACTIVE';
            const btnText = isDrained ? 'Enable' : 'Drain';
            const btnClass = isDrained ? 'btn-primary' : 'btn-danger';
            const action = isDrained ? 'enable' : 'drain';
            return '<tr>' +
              '<td>' + escapeHtml(o.id) + '</td>' +
              '<td><span class="badge ' + badgeClass + '">' + badgeText + '</span></td>' +
              '<td>' + escapeHtml(o.circuitBreaker || 'closed') + '</td>' +
              '<td>' + (o.weight || 100) + '</td>' +
              '<td><button class="btn ' + btnClass + '" data-origin-id="' + escapeHtml(o.id) + '" data-action="' + action + '">' + btnText + '</button></td>' +
            '</tr>';
          }).join('') || '<tr><td colspan="5">No configured origins</td></tr>';
        }

        // Routes
        const routesRes = await fetch('/admin/api/v1/routes', { headers });
        if (routesRes.ok) {
          const data = await routesRes.json();
          document.getElementById('route-version').textContent = 'v' + (data.version || 1);
          const tbody = document.querySelector('#table-routes tbody');
          tbody.innerHTML = (data.routes || []).map(r => {
            return '<tr>' +
              '<td><code>' + escapeHtml(r.pathPattern || r.path || '/*') + '</code></td>' +
              '<td>' + escapeHtml(r.origin || 'origin-primary') + '</td>' +
              '<td>' + (r.priority || 1) + '</td>' +
            '</tr>';
          }).join('') || '<tr><td colspan="3">Default root proxy pass</td></tr>';
        }

        // Tenants
        const tenantsRes = await fetch('/admin/api/v1/tenants', { headers });
        if (tenantsRes.ok) {
          const data = await tenantsRes.json();
          const tbody = document.querySelector('#table-tenants tbody');
          tbody.innerHTML = (data.tenants || []).map(t => {
            return '<tr>' +
              '<td><strong>' + escapeHtml(t.tenant) + '</strong></td>' +
              '<td>' + ((t.hitRatio || 0) * 100).toFixed(1) + '%</td>' +
              '<td>' + formatBytes(t.bytesStored) + '</td>' +
              '<td>' + formatBytes(t.quota) + '</td>' +
              '<td>' + (t.requests || 0).toLocaleString() + '</td>' +
            '</tr>';
          }).join('');
        }

        // Inspect Decisions
        const inspectRes = await fetch('/admin/api/v1/inspect', { headers });
        if (inspectRes.ok) {
          const data = await inspectRes.json();
          const tbody = document.querySelector('#table-inspect tbody');
          tbody.innerHTML = (data.decisions || []).slice(0, 15).map(d => {
            const badge = d.decision === 'HIT' ? 'badge-success' : (d.decision === 'MISS' ? 'badge-warning' : 'badge-danger');
            return '<tr>' +
              '<td>' + new Date(d.timestamp || Date.now()).toLocaleTimeString() + '</td>' +
              '<td><code>' + escapeHtml(d.url) + '</code></td>' +
              '<td><span class="badge ' + badge + '">' + escapeHtml(d.decision) + '</span></td>' +
              '<td><code>' + escapeHtml((d.cacheKey || '').slice(0, 16)) + '...</code></td>' +
              '<td>' + escapeHtml(d.origin || 'cache') + '</td>' +
            '</tr>';
          }).join('') || '<tr><td colspan="5">No request decisions recorded yet</td></tr>';
        }

        // Audit Log
        const auditRes = await fetch('/admin/api/v1/audit', { headers });
        if (auditRes.ok) {
          const data = await auditRes.json();
          const tbody = document.querySelector('#table-audit tbody');
          tbody.innerHTML = (data.entries || []).slice(-10).reverse().map(e => {
            return '<tr>' +
              '<td>' + new Date(e.timestamp).toLocaleTimeString() + '</td>' +
              '<td>' + escapeHtml(e.actor) + '</td>' +
              '<td>' + escapeHtml(e.scope) + '</td>' +
              '<td><code>' + escapeHtml(e.target) + '</code></td>' +
              '<td><span class="badge ' + (e.outcome === 'success' ? 'badge-success' : 'badge-danger') + '">' + escapeHtml(e.outcome) + '</span></td>' +
              '<td><code style="font-size:0.75rem;">' + escapeHtml(e.hash.slice(0, 16)) + '...</code></td>' +
            '</tr>';
          }).join('') || '<tr><td colspan="6">No purge operations recorded</td></tr>';
        }

      } catch (err) {
        document.getElementById('header-status').textContent = 'Status: Disconnected (' + err.message + ')';
      }
    }

    // Window global functions for interactive UI buttons
    window.toggleOrigin = async function(originId, action) {
      try {
        const res = await fetch('/admin/api/v1/origins/' + originId + '/' + action, {
          method: 'POST',
          headers: getAuthHeaders()
        });
        if (res.ok) {
          showAlert('Origin ' + originId + ' marked as ' + action + 'ed successfully.');
          pollLiveTelemetry();
        } else {
          showAlert('Failed to update origin ' + originId, true);
        }
      } catch (e) {
        showAlert('Error: ' + e.message, true);
      }
    };

    document.querySelector('#table-origins').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-origin-id]');
      if (btn) {
        toggleOrigin(btn.getAttribute('data-origin-id'), btn.getAttribute('data-action'));
      }
    });

    document.getElementById('btn-save-route').addEventListener('click', async () => {
      const pathVal = document.getElementById('route-path').value.trim();
      const originVal = document.getElementById('route-origin').value.trim();
      if (!pathVal || !originVal) {
        showAlert('Please provide both path pattern and target origin', true);
        return;
      }
      try {
        const res = await fetch('/admin/api/v1/routes', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ path: pathVal, origin: originVal, priority: 10 })
        });
        if (res.ok) {
          showAlert('Route ' + pathVal + ' applied successfully!');
          document.getElementById('route-path').value = '';
          document.getElementById('route-origin').value = '';
          pollLiveTelemetry();
        } else {
          showAlert('Failed to apply route', true);
        }
      } catch (e) {
        showAlert('Route error: ' + e.message, true);
      }
    });

    document.getElementById('btn-resolve-policy').addEventListener('click', async () => {
      const u = document.getElementById('policy-url').value.trim();
      const t = document.getElementById('policy-tenant').value.trim();
      try {
        const res = await fetch('/admin/api/v1/policies/resolve?url=' + encodeURIComponent(u) + '&tenant=' + encodeURIComponent(t), {
          headers: getAuthHeaders()
        });
        if (res.ok) {
          const json = await res.json();
          document.getElementById('policy-result').innerHTML = '<pre>' + escapeHtml(JSON.stringify(json, null, 2)) + '</pre>';
        } else {
          document.getElementById('policy-result').textContent = 'Policy resolve returned status ' + res.status;
        }
      } catch (e) {
        document.getElementById('policy-result').textContent = 'Resolve error: ' + e.message;
      }
    });

    document.getElementById('btn-submit-purge').addEventListener('click', async () => {
      const type = document.getElementById('purge-type').value;
      const target = document.getElementById('purge-target').value.trim();
      const soft = document.getElementById('purge-soft').checked;
      if (!target) {
        showAlert('Purge target pattern is required', true);
        return;
      }
      try {
        const res = await fetch('/admin/api/v1/purge', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ type, target, soft })
        });
        const out = document.getElementById('purge-output');
        if (res.ok) {
          const data = await res.json();
          showAlert('Purge successful: ' + (data.purgedCount !== undefined ? data.purgedCount + ' entries invalidated' : 'Job queued ' + data.jobId));
          out.innerHTML = '<span style="color:var(--success);">Result: ' + JSON.stringify(data) + '</span>';
          document.getElementById('purge-target').value = '';
          pollLiveTelemetry();
        } else {
          const err = await res.json();
          showAlert('Purge failed: ' + (err.error?.message || res.statusText), true);
          out.innerHTML = '<span style="color:var(--danger);">Error: ' + JSON.stringify(err) + '</span>';
        }
      } catch (e) {
        showAlert('Purge network error: ' + e.message, true);
      }
    });

    // Start live polling loop
    pollLiveTelemetry();
    setInterval(pollLiveTelemetry, 3000);
  </script>
</body>
</html>`;
}
