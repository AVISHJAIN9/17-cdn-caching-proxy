'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';

interface MetricSnapshot {
  timestamp: number;
  hitRatio: number;
  byteHitRatio: number;
  requestsPerSec: number;
  bytesPerSec: number;
  evictionsPerSec: number;
  originLatencyP50: number;
  originLatencyP95: number;
  originLatencyP99: number;
  cacheBytesMemory: number;
  cacheBytesDisk: number;
  cacheObjectsCount: number;
}

interface OverviewData {
  objectsCount: number;
  totalBytes: number;
  hitRatio: number;
  byteHitRatio: number;
}

interface StatusData {
  status: string;
  nodeId: string;
  uptimeSeconds: number;
  version: string;
}

interface OriginItem {
  id: string;
  healthy: boolean;
  drained: boolean;
  weight: number;
  circuitBreaker: string;
}

interface RouteItem {
  id: string;
  pathPattern?: string;
  origin: string;
  priority?: number;
}

interface TenantItem {
  tenant: string;
  hitRatio: number;
  bytesStored: number;
  quota: number;
  requests: number;
}

interface DecisionItem {
  timestamp: number;
  url: string;
  decision: string;
  cacheKey: string;
  origin: string;
  statusCode: number;
}

interface AuditItem {
  id: string;
  timestamp: number;
  actor: string;
  scope: string;
  target: string;
  outcome: string;
  hash: string;
}

export default function DashboardPage() {
  const [adminUrl, setAdminUrl] = useState(
    typeof window !== 'undefined'
      ? (process.env.NEXT_PUBLIC_ADMIN_URL || `${window.location.protocol}//${window.location.hostname}:9090`)
      : 'http://localhost:9090'
  );
  const [token, setToken] = useState('admin-secret');
  const [activeTab, setActiveTab] = useState<'overview' | 'charts' | 'origins' | 'routes' | 'policies' | 'purge' | 'tenants' | 'inspect'>('overview');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  // Live state
  const [status, setStatus] = useState<StatusData | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [timeseries, setTimeseries] = useState<MetricSnapshot[]>([]);
  const [origins, setOrigins] = useState<OriginItem[]>([]);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [tenants, setTenants] = useState<TenantItem[]>([]);
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  // Policy resolver state
  const [resolveUrl, setResolveUrl] = useState('/catalog/items');
  const [resolveTenant, setResolveTenant] = useState('default');
  const [policyResult, setPolicyResult] = useState<any>(null);

  // New route form state
  const [newRoutePath, setNewRoutePath] = useState('/api/v2/*');
  const [newRouteOrigin, setNewRouteOrigin] = useState('origin-backup');

  // Purge form state
  const [purgeTarget, setPurgeTarget] = useState('/catalog/*');
  const [purgeScope, setPurgeScope] = useState<'url' | 'prefix' | 'tag' | 'tenant'>('prefix');
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  const fetchHeaders = useCallback(() => {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, [token]);

  const pollBackend = useCallback(async () => {
    try {
      const headers = fetchHeaders();
      const base = adminUrl.replace(/\/$/, '');

      const [stRes, ovRes, tsRes, orRes, roRes, teRes, deRes, auRes] = await Promise.all([
        fetch(`${base}/admin/api/v1/status`, { headers }),
        fetch(`${base}/admin/api/v1/overview`, { headers }),
        fetch(`${base}/admin/api/v1/timeseries`, { headers }),
        fetch(`${base}/admin/api/v1/origins`, { headers }),
        fetch(`${base}/admin/api/v1/routes`, { headers }),
        fetch(`${base}/admin/api/v1/tenants`, { headers }),
        fetch(`${base}/admin/api/v1/inspect`, { headers }),
        fetch(`${base}/admin/api/v1/audit`, { headers }),
      ]);

      if (stRes.ok && ovRes.ok) {
        setStatus(await stRes.json());
        setOverview(await ovRes.json());
        setConnected(true);
        setErrorMsg(null);
      } else {
        setConnected(false);
        setErrorMsg(`API error: status code ${stRes.status}`);
      }

      if (tsRes.ok) {
        const d = await tsRes.json();
        setTimeseries(d.points || []);
      }
      if (orRes.ok) {
        const d = await orRes.json();
        setOrigins(d.origins || []);
      }
      if (roRes.ok) {
        const d = await roRes.json();
        setRoutes(d.routes || []);
      }
      if (teRes.ok) {
        const d = await teRes.json();
        setTenants(d.tenants || []);
      }
      if (deRes.ok) {
        const d = await deRes.json();
        setDecisions(d.decisions || []);
      }
      if (auRes.ok) {
        const d = await auRes.json();
        setAudit(d.entries || []);
      }
    } catch (err: any) {
      setConnected(false);
      setErrorMsg(`Failed to connect to backend at ${adminUrl}: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [adminUrl, fetchHeaders]);

  useEffect(() => {
    pollBackend();
    const interval = setInterval(pollBackend, 3000);
    return () => clearInterval(interval);
  }, [pollBackend]);

  const toggleOriginDrain = async (originId: string, action: 'drain' | 'enable') => {
    try {
      const base = adminUrl.replace(/\/$/, '');
      const res = await fetch(`${base}/admin/api/v1/origins/${originId}/${action}`, {
        method: 'POST',
        headers: fetchHeaders(),
      });
      if (res.ok) {
        setActionBanner(`Origin ${originId} successfully ${action}ed`);
        await pollBackend();
      } else {
        setActionBanner(`Failed to ${action} origin ${originId}`);
      }
    } catch (e: any) {
      setActionBanner(`Error: ${e.message}`);
    }
  };

  const addRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const base = adminUrl.replace(/\/$/, '');
      const res = await fetch(`${base}/admin/api/v1/routes`, {
        method: 'POST',
        headers: fetchHeaders(),
        body: JSON.stringify({
          path: newRoutePath,
          origin: newRouteOrigin,
          priority: 10,
        }),
      });
      if (res.ok) {
        setActionBanner(`Route ${newRoutePath} applied successfully`);
        setNewRoutePath('');
        await pollBackend();
      } else {
        setActionBanner('Failed to add route');
      }
    } catch (e: any) {
      setActionBanner(`Error: ${e.message}`);
    }
  };

  const resolvePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const base = adminUrl.replace(/\/$/, '');
      const res = await fetch(
        `${base}/admin/api/v1/policies/resolve?url=${encodeURIComponent(resolveUrl)}&tenant=${encodeURIComponent(resolveTenant)}`,
        { headers: fetchHeaders() }
      );
      if (res.ok) {
        setPolicyResult(await res.json());
      }
    } catch (e: any) {
      setPolicyResult({ error: e.message });
    }
  };

  const executePurge = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const base = adminUrl.replace(/\/$/, '');
      const res = await fetch(`${base}/admin/api/v1/purge`, {
        method: 'POST',
        headers: fetchHeaders(),
        body: JSON.stringify({
          scope: purgeScope,
          target: purgeTarget,
          tenant: 'default',
        }),
      });
      const data = await res.json();
      setPurgeResult(JSON.stringify(data, null, 2));
      await pollBackend();
    } catch (e: any) {
      setPurgeResult(JSON.stringify({ error: e.message }));
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-3">
            <span>CDN Caching Proxy Control Plane</span>
            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-semibold ${
                connected ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
              }`}
            >
              {connected ? `Connected (${status?.nodeId ?? 'online'})` : 'Disconnected'}
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Uptime: {status?.uptimeSeconds ?? 0}s | Live poll active (every 3s)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            className="bg-slate-950 border border-slate-700 text-xs px-3 py-1.5 rounded text-slate-200"
            value={adminUrl}
            onChange={(e) => setAdminUrl(e.target.value)}
            placeholder="Backend URL (http://localhost:9090)"
          />
          <input
            type="password"
            className="bg-slate-950 border border-slate-700 text-xs px-3 py-1.5 rounded text-slate-200 w-28"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Admin Token"
          />
          <button
            onClick={pollBackend}
            className="bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-semibold px-3 py-1.5 rounded"
          >
            Refresh
          </button>
        </div>
      </div>

      {actionBanner && (
        <div className="p-3 bg-cyan-950 border border-cyan-800 text-cyan-300 rounded-lg text-sm flex justify-between">
          <span>{actionBanner}</span>
          <button onClick={() => setActionBanner(null)} className="text-xs font-bold text-cyan-400">✕</button>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 bg-rose-950 border border-rose-800 text-rose-300 rounded-lg text-sm">
          {errorMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
        {[
          ['overview', '1. Cache Overview'],
          ['charts', '2. Live Charts'],
          ['origins', '3. Origin Health & Pools'],
          ['routes', '4. Route Config'],
          ['policies', '5. Cache Policies'],
          ['purge', '6. Purge & Audit'],
          ['tenants', '7. Tenants'],
          ['inspect', '8. Request Inspection'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key as any)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === key
                ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 1. OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-slate-400 text-xs">CACHE HIT RATIO</div>
            <div className="text-3xl font-extrabold text-emerald-400 mt-2">
              {((overview?.hitRatio ?? 0) * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-slate-500 mt-1">Live requests hit ratio</div>
          </div>
          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-slate-400 text-xs">BYTE HIT RATIO</div>
            <div className="text-3xl font-extrabold text-cyan-400 mt-2">
              {((overview?.byteHitRatio ?? 0) * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-slate-500 mt-1">Bandwidth savings</div>
          </div>
          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-slate-400 text-xs">CACHED OBJECTS</div>
            <div className="text-3xl font-extrabold text-purple-400 mt-2">
              {(overview?.objectsCount ?? 0).toLocaleString()}
            </div>
            <div className="text-xs text-slate-500 mt-1">Entries currently indexed</div>
          </div>
          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-slate-400 text-xs">STORED BYTES</div>
            <div className="text-3xl font-extrabold text-amber-400 mt-2">
              {formatBytes(overview?.totalBytes)}
            </div>
            <div className="text-xs text-slate-500 mt-1">Memory & storage tiers</div>
          </div>
        </div>
      )}

      {/* 2. CHARTS */}
      {activeTab === 'charts' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-sm font-semibold text-white mb-4">Traffic & Requests per Second</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="timestamp" tickFormatter={(t) => new Date(t).toLocaleTimeString()} stroke="#64748b" />
                  <YAxis stroke="#64748b" />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                  <Area type="monotone" dataKey="requestsPerSec" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-sm font-semibold text-white mb-4">Hit Ratio Over Time</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="timestamp" tickFormatter={(t) => new Date(t).toLocaleTimeString()} stroke="#64748b" />
                  <YAxis domain={[0, 1]} stroke="#64748b" />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                  <Line type="monotone" dataKey="hitRatio" stroke="#4ade80" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="byteHitRatio" stroke="#22d3ee" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-sm font-semibold text-white mb-4">Origin Latency Percentiles (p50 / p95 / p99)</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="timestamp" tickFormatter={(t) => new Date(t).toLocaleTimeString()} stroke="#64748b" />
                  <YAxis stroke="#64748b" />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                  <Line type="monotone" dataKey="originLatencyP50" stroke="#facc15" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="originLatencyP95" stroke="#f97316" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="originLatencyP99" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-sm font-semibold text-white mb-4">Cache Storage & Eviction Rates</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="timestamp" tickFormatter={(t) => new Date(t).toLocaleTimeString()} stroke="#64748b" />
                  <YAxis stroke="#64748b" tickFormatter={(b) => formatBytes(b)} />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                  <Area type="monotone" dataKey="cacheBytesMemory" stroke="#a855f7" fill="#a855f7" fillOpacity={0.2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* 3. ORIGIN HEALTH */}
      {activeTab === 'origins' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <h2 className="text-base font-semibold text-white">Configured Origins & Dynamic Drain Controls</h2>
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th className="py-2">Origin ID</th>
                <th>Status</th>
                <th>Circuit Breaker</th>
                <th>Weight</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {origins.map((o) => (
                <tr key={o.id}>
                  <td className="py-3 font-mono">{o.id}</td>
                  <td>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        o.drained ? 'bg-rose-950 text-rose-400 border border-rose-800' : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      }`}
                    >
                      {o.drained ? 'DRAINED' : 'ACTIVE'}
                    </span>
                  </td>
                  <td><span className="font-mono text-slate-400">{o.circuitBreaker}</span></td>
                  <td>{o.weight}</td>
                  <td>
                    <button
                      onClick={() => toggleOriginDrain(o.id, o.drained ? 'enable' : 'drain')}
                      className={`text-[11px] font-semibold px-3 py-1 rounded transition-colors ${
                        o.drained ? 'bg-emerald-500 text-black hover:bg-emerald-400' : 'bg-rose-600 text-white hover:bg-rose-500'
                      }`}
                    >
                      {o.drained ? 'Enable Traffic' : 'Drain Origin'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4. ROUTE CONFIG */}
      {activeTab === 'routes' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-4">Add Dynamic Proxy Route</h2>
            <form onSubmit={addRoute} className="flex gap-4">
              <input
                type="text"
                placeholder="Path pattern (e.g. /api/v2/*)"
                className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded flex-1 text-slate-200"
                value={newRoutePath}
                onChange={(e) => setNewRoutePath(e.target.value)}
                required
              />
              <input
                type="text"
                placeholder="Target Origin ID"
                className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded w-48 text-slate-200"
                value={newRouteOrigin}
                onChange={(e) => setNewRouteOrigin(e.target.value)}
                required
              />
              <button
                type="submit"
                className="bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs px-4 py-2 rounded"
              >
                Apply Route
              </button>
            </form>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-3">Active Routing Rules</h2>
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2">Path Pattern</th>
                  <th>Target Origin</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {routes.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 font-mono text-cyan-400">{r.pathPattern || '/*'}</td>
                    <td className="font-mono">{r.origin}</td>
                    <td>{r.priority ?? 1}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 5. POLICIES */}
      {activeTab === 'policies' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <h2 className="text-base font-semibold text-white">Live Cache Policy Resolver</h2>
          <form onSubmit={resolvePolicy} className="flex gap-4">
            <input
              type="text"
              placeholder="Request URL (e.g. /catalog/items)"
              className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded flex-1 text-slate-200"
              value={resolveUrl}
              onChange={(e) => setResolveUrl(e.target.value)}
            />
            <input
              type="text"
              placeholder="Tenant (e.g. default)"
              className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded w-40 text-slate-200"
              value={resolveTenant}
              onChange={(e) => setResolveTenant(e.target.value)}
            />
            <button
              type="submit"
              className="bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs px-4 py-2 rounded"
            >
              Resolve Policy
            </button>
          </form>

          {policyResult && (
            <div className="mt-4 p-4 bg-slate-950 border border-slate-800 rounded-lg">
              <div className="text-xs font-semibold text-slate-400 mb-2">Effective Policy:</div>
              <pre className="text-xs font-mono text-emerald-400 overflow-x-auto">
                {JSON.stringify(policyResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 6. PURGE & AUDIT */}
      {activeTab === 'purge' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-4">Purge Cache Objects</h2>
            <form onSubmit={executePurge} className="space-y-4">
              <div className="flex gap-4">
                <select
                  value={purgeScope}
                  onChange={(e) => setPurgeScope(e.target.value as any)}
                  className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded text-slate-200"
                >
                  <option value="url">Single URL</option>
                  <option value="prefix">Prefix Path</option>
                  <option value="tag">Cache-Tag</option>
                  <option value="tenant">Tenant</option>
                </select>
                <input
                  type="text"
                  placeholder="Purge Target (e.g. /catalog/*)"
                  className="bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded flex-1 text-slate-200"
                  value={purgeTarget}
                  onChange={(e) => setPurgeTarget(e.target.value)}
                  required
                />
                <button
                  type="submit"
                  className="bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs px-5 py-2 rounded"
                >
                  Execute Purge
                </button>
              </div>
            </form>
            {purgeResult && (
              <pre className="mt-4 p-3 bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300 rounded">
                {purgeResult}
              </pre>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-3">Purge Audit Log (SHA-256 Verified)</h2>
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="py-2">Timestamp</th>
                  <th>Actor</th>
                  <th>Scope</th>
                  <th>Target</th>
                  <th>Outcome</th>
                  <th>Audit Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {audit.slice(-10).reverse().map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 font-mono text-slate-400">{new Date(a.timestamp).toLocaleTimeString()}</td>
                    <td>{a.actor}</td>
                    <td>{a.scope}</td>
                    <td className="font-mono text-cyan-400">{a.target}</td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        a.outcome === 'success' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'
                      }`}>
                        {a.outcome}
                      </span>
                    </td>
                    <td className="font-mono text-[10px] text-slate-500">{a.hash.slice(0, 16)}...</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 7. TENANTS */}
      {activeTab === 'tenants' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-base font-semibold text-white mb-4">Multi-Tenant Quota & Bandwidth Utilization</h2>
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th className="py-2">Tenant Name</th>
                <th>Hit Ratio</th>
                <th>Stored Bytes</th>
                <th>Quota Limit</th>
                <th>Total Requests</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {tenants.map((t) => (
                <tr key={t.tenant}>
                  <td className="py-3 font-semibold text-white">{t.tenant}</td>
                  <td className="text-emerald-400 font-mono">{((t.hitRatio ?? 0) * 100).toFixed(1)}%</td>
                  <td>{formatBytes(t.bytesStored)}</td>
                  <td>{formatBytes(t.quota)}</td>
                  <td>{t.requests.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 8. REQUEST INSPECTION */}
      {activeTab === 'inspect' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-base font-semibold text-white mb-4">Live Request Decisions Ring Buffer</h2>
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th className="py-2">Time</th>
                <th>Target URL</th>
                <th>Decision</th>
                <th>Status</th>
                <th>Origin / Source</th>
                <th>Cache Key</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {decisions.map((d, i) => (
                <tr key={i}>
                  <td className="py-2.5 font-mono text-slate-500">{new Date(d.timestamp).toLocaleTimeString()}</td>
                  <td className="font-mono text-slate-200">{d.url}</td>
                  <td>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        d.decision === 'HIT'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : d.decision === 'MISS'
                          ? 'bg-amber-950 text-amber-400 border border-amber-800'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {d.decision}
                    </span>
                  </td>
                  <td className="font-mono">{d.statusCode}</td>
                  <td className="text-slate-400">{d.origin}</td>
                  <td className="font-mono text-[10px] text-slate-500">{(d.cacheKey || '').slice(0, 16)}...</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
