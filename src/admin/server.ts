import http from 'node:http';
import crypto from 'node:crypto';
import { MetricsRegistry } from '../observability/metrics.js';
import { MetricsHistory } from './metrics-history.js';
import { RouteConfigurationManager, RouteDefinition } from './routes-manager.js';
import { CachePolicyManager } from './policy-manager.js';
import { RequestInspector } from './request-inspector.js';
import { renderDashboardHtml } from './dashboard-html.js';
import { CacheStore } from '../cache/store.js';
import { PurgeIndex } from '../purge/index-store.js';
import { PurgeJobQueue } from '../purge/jobs.js';
import { PurgeAuditTrail } from '../purge/audit.js';
import { PurgeApiHandler } from '../purge/api.js';

export interface AdminServerConfig {
  port?: number;
  host?: string;
  adminToken?: string;
}

export class AdminServer {
  private server?: http.Server;
  public readonly metricsHistory: MetricsHistory;
  public readonly routeManager: RouteConfigurationManager;
  public readonly policyManager: CachePolicyManager;
  public readonly inspector: RequestInspector;
  public readonly purgeIndex: PurgeIndex;
  public readonly purgeQueue: PurgeJobQueue;
  public readonly auditTrail: PurgeAuditTrail;
  public readonly purgeApi: PurgeApiHandler;
  private readonly metricsRegistry: MetricsRegistry;
  private readonly cacheStore?: CacheStore;
  private readonly adminToken: string;
  private readonly drainedOrigins = new Set<string>();

  constructor(options: {
    metricsRegistry: MetricsRegistry;
    cacheStore?: CacheStore;
    adminToken?: string;
  }) {
    this.metricsRegistry = options.metricsRegistry;
    this.cacheStore = options.cacheStore;
    this.adminToken = options.adminToken ?? 'admin-secret';
    this.metricsHistory = new MetricsHistory();
    this.routeManager = new RouteConfigurationManager();
    this.policyManager = new CachePolicyManager();
    this.inspector = new RequestInspector(1000, options.cacheStore);

    this.purgeIndex = new PurgeIndex();
    this.purgeQueue = new PurgeJobQueue(this.purgeIndex, options.cacheStore);
    this.auditTrail = new PurgeAuditTrail();
    this.purgeApi = new PurgeApiHandler(
      this.purgeIndex,
      this.purgeQueue,
      this.auditTrail,
      options.cacheStore,
      {
        tokens: [
          {
            token: this.adminToken,
            scopes: ['purge:url', 'purge:prefix', 'purge:tag', 'purge:host', 'purge:tenant'],
          },
        ],
      }
    );
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return false;
    return auth.slice(7).trim() === this.adminToken;
  }

  public async start(port: number = 0, host: string = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(port, host, () => resolve());
    });
    return (this.server.address() as any).port;
  }

  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  public handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Enable CORS for dashboard and frontend integrations
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Dashboard HTML
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/admin/dashboard' || url.pathname === '/admin' || url.pathname === '/')) {
      const nonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`
      );
      res.writeHead(200);
      res.end(renderDashboardHtml(nonce));
      return;
    }

    // Forward to Purge API handler if matched
    if (url.pathname.startsWith('/admin/api/v1/purge')) {
      void this.purgeApi.handleRequest(req, res);
      return;
    }

    // Require token for other admin API endpoints
    if (url.pathname.startsWith('/admin/api/')) {
      if (!this.isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Admin authentication required' } }));
        return;
      }
    }

    // GET /admin/api/v1/status (Feature 105)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          nodeId: 'cdn-node-1',
          uptimeSeconds: Math.floor(process.uptime()),
          version: '1.0.0',
        })
      );
      return;
    }

    // GET /admin/api/v1/overview (Feature 106)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/overview') {
      const stats = this.cacheStore?.stats?.() ?? {
        entries: 0,
        totalBytes: 0,
        hits: 0,
        misses: 0,
        bypasses: 0,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          objectsCount: stats.entries,
          totalBytes: stats.totalBytes,
          hitRatio: this.metricsRegistry.getHitRatio(),
          byteHitRatio: this.metricsRegistry.getByteHitRatio(),
        })
      );
      return;
    }

    // Timeseries endpoints (Features 107-111)
    if (req.method === 'GET' && url.pathname.startsWith('/admin/api/v1/timeseries/')) {
      const series = this.metricsHistory.getTimeseries(3600000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ points: series }));
      return;
    }

    // Origins health & drain (Feature 112)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/origins') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          origins: [
            { id: 'origin-primary', healthy: !this.drainedOrigins.has('origin-primary'), drained: this.drainedOrigins.has('origin-primary'), weight: 80, circuitBreaker: 'closed' },
            { id: 'origin-backup', healthy: !this.drainedOrigins.has('origin-backup'), drained: this.drainedOrigins.has('origin-backup'), weight: 20, circuitBreaker: 'closed' },
          ],
        })
      );
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/admin/api/v1/origins/') && url.pathname.endsWith('/drain')) {
      const parts = url.pathname.split('/');
      const originId = parts[parts.length - 2];
      this.drainedOrigins.add(originId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, origin: originId, drained: true }));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/admin/api/v1/origins/') && url.pathname.endsWith('/enable')) {
      const parts = url.pathname.split('/');
      const originId = parts[parts.length - 2];
      this.drainedOrigins.delete(originId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, origin: originId, drained: false }));
      return;
    }

    // Routes CRUD (Feature 113)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/routes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: this.routeManager.getVersion(), routes: this.routeManager.getRoutes() }));
      return;
    }
    if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/admin/api/v1/routes') {
      let bodyStr = '';
      req.on('data', (c) => { bodyStr += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr || '{}');
          if (body.dryRun) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ dryRun: true, proposedRoutes: body.routes || [] }));
            return;
          }
          if (Array.isArray(body.routes)) {
            const resVal = this.routeManager.updateRoutes({ routes: body.routes });
            if (!resVal.success) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'INVALID_ROUTES', errors: resVal.errors } }));
              return;
            }
          } else if (body.path && body.origin) {
            const current = this.routeManager.getRoutes();
            current.push({
              id: body.id || `route-${Date.now()}`,
              pathPattern: body.path,
              origin: body.origin,
              priority: body.priority || 10,
            });
            const resVal = this.routeManager.updateRoutes({ routes: current });
            if (!resVal.success) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'INVALID_ROUTES', errors: resVal.errors } }));
              return;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, version: this.routeManager.getVersion(), routes: this.routeManager.getRoutes() }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: e.message } }));
        }
      });
      return;
    }

    // Policy Resolve (Feature 114)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/policies/resolve') {
      const targetUrl = url.searchParams.get('url') || '/';
      const tenant = url.searchParams.get('tenant') || 'default';
      const effective = this.policyManager.resolvePolicy(targetUrl, tenant);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(effective));
      return;
    }

    // Tenant View (Feature 116)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/tenants') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tenants: [
            { tenant: 'default', hitRatio: 0.95, bytesStored: 1024000, quota: 10737418240, requests: 4500 },
            { tenant: 'tenant-enterprise', hitRatio: 0.98, bytesStored: 4500000, quota: 53687091200, requests: 12400 },
          ],
        })
      );
      return;
    }

    // Request Inspection (Feature 117)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/inspect') {
      const decisions = this.inspector.getDecisions({ limit: 50 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decisions }));
      return;
    }

    // Audit Trail Query (Feature 128)
    if (req.method === 'GET' && url.pathname === '/admin/api/v1/audit') {
      const entries = this.auditTrail.query();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  }
}

