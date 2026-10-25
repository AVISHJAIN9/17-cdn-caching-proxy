import http from 'node:http';
import { PurgeIndex, PurgeTarget, PurgeResult } from './index-store.js';
import { PurgeJobQueue } from './jobs.js';
import { PurgeAuditTrail } from './audit.js';
import { CacheStore } from '../cache/store.js';

export interface PurgeTokenScope {
  token: string;
  tenant?: string; // If set, token is bound to this tenant only
  scopes: Array<'purge:url' | 'purge:prefix' | 'purge:tag' | 'purge:host' | 'purge:tenant'>;
}

export interface PurgeApiConfig {
  tokens?: PurgeTokenScope[];
  syncThresholdCount?: number; // default 50
}

export class PurgeApiHandler {
  private readonly purgeIndex: PurgeIndex;
  private readonly jobQueue: PurgeJobQueue;
  private readonly auditTrail: PurgeAuditTrail;
  private readonly cacheStore?: CacheStore;
  private readonly tokens = new Map<string, PurgeTokenScope>();
  private readonly syncThreshold: number;

  constructor(
    purgeIndex: PurgeIndex,
    jobQueue: PurgeJobQueue,
    auditTrail: PurgeAuditTrail,
    cacheStore?: CacheStore,
    config: PurgeApiConfig = {}
  ) {
    this.purgeIndex = purgeIndex;
    this.jobQueue = jobQueue;
    this.auditTrail = auditTrail;
    this.cacheStore = cacheStore;
    this.syncThreshold = config.syncThresholdCount ?? 50;

    if (config.tokens) {
      for (const t of config.tokens) {
        this.tokens.set(t.token, t);
      }
    }
  }

  public registerToken(tokenScope: PurgeTokenScope): void {
    this.tokens.set(tokenScope.token, tokenScope);
  }

  /**
   * Authenticates and authorizes a purge request based on bearer token scopes and tenant binding.
   */
  public authenticateAndAuthorize(
    authHeader: string | undefined,
    requiredScope: 'purge:url' | 'purge:prefix' | 'purge:tag' | 'purge:host' | 'purge:tenant',
    requestedTenant?: string
  ): { ok: true; actor: string; tenant: string } | { ok: false; status: number; error: string } {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Missing or malformed Authorization header' };
    }

    const token = authHeader.slice(7).trim();
    const tokenConfig = this.tokens.get(token);
    if (!tokenConfig) {
      return { ok: false, status: 401, error: 'Invalid purge token' };
    }

    // Check scope permission
    if (!tokenConfig.scopes.includes(requiredScope)) {
      return { ok: false, status: 403, error: `Token lacks required scope ${requiredScope}` };
    }

    // Check tenant boundary
    if (tokenConfig.tenant && requestedTenant && tokenConfig.tenant !== requestedTenant) {
      return { ok: false, status: 403, error: `Token bound to tenant ${tokenConfig.tenant} cannot purge tenant ${requestedTenant}` };
    }

    const effectiveTenant = tokenConfig.tenant ?? requestedTenant ?? 'default';
    return { ok: true, actor: `token:${token.slice(0, 8)}`, tenant: effectiveTenant };
  }

  /**
   * Handles incoming HTTP requests for purge endpoints.
   */
  public async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // GET /admin/api/v1/purge/status/:id
    if (req.method === 'GET' && url.pathname.startsWith('/admin/api/v1/purge/status/')) {
      const id = url.pathname.split('/').pop()!;
      const job = this.jobQueue.getJob(id);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Job not found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
      return;
    }

    // POST /admin/api/v1/purge
    if (req.method === 'POST' && url.pathname === '/admin/api/v1/purge') {
      let bodyStr = '';
      for await (const chunk of req) bodyStr += chunk;

      let body: any;
      try {
        body = JSON.parse(bodyStr || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Malformed JSON payload' } }));
        return;
      }

      const { type, target, tenant, soft, idempotencyKey } = body;
      if (!type || !target || typeof target !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Fields type and target are required' } }));
        return;
      }

      const requiredScope = `purge:${type}` as any;
      const auth = this.authenticateAndAuthorize(req.headers.authorization, requiredScope, tenant);
      if (!auth.ok) {
        this.auditTrail.record({
          actor: 'unauthorized',
          tenant: tenant ?? 'default',
          action: 'purge',
          scope: type,
          target,
          outcome: 'denied',
        });
        res.writeHead(auth.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: auth.error } }));
        return;
      }

      const purgeTarget: PurgeTarget = {
        type,
        target,
        tenant: auth.tenant,
        soft: Boolean(soft),
      };

      // Single-URL or small target: synchronous execution
      if (type === 'url') {
        const result: PurgeResult = this.purgeIndex.executePurge(purgeTarget, this.cacheStore);
        this.auditTrail.record({
          actor: auth.actor,
          tenant: auth.tenant,
          action: 'purge:sync',
          scope: type,
          target,
          outcome: 'success',
          details: { ...result },
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', result }));
        return;
      }

      // Wide target (prefix, tag, host, tenant): asynchronous job
      const job = this.jobQueue.submitJob({
        target: purgeTarget,
        tenant: auth.tenant,
        idempotencyKey,
      });

      this.auditTrail.record({
        actor: auth.actor,
        tenant: auth.tenant,
        action: 'purge:async',
        scope: type,
        target,
        outcome: 'success',
        details: { jobId: job.id },
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', jobId: job.id, job }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  }
}
