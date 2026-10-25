import { describe, it, expect, beforeEach } from 'vitest';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeAuditTrail } from '../src/purge/audit.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';
import { PurgeApiHandler } from '../src/purge/api.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { CacheEntry } from '../src/cache/store.js';

describe('Group C: Purge System (Features 118–128)', () => {
  let index: PurgeIndex;
  let store: MemoryStore;
  let audit: PurgeAuditTrail;
  let queue: PurgeJobQueue;
  let api: PurgeApiHandler;

  const makeEntry = (hash: string, url: string, tenant: string = 'default'): CacheEntry => ({
    keyHash: hash,
    keyString: url,
    originId: 'default',
    namespace: tenant,
    status: 200,
    statusMessage: 'OK',
    headers: { 'cache-control': 'public, max-age=3600' },
    body: Buffer.from(`body-${hash}`),
    size: 10,
    storedAt: Date.now(),
    hitCount: 1,
    lastAccessedAt: Date.now(),
    requestTimeMs: Date.now(),
    responseTimeMs: Date.now(),
    dateValueMs: Date.now(),
    ageValueSeconds: 0,
    freshnessLifetimeMs: 3600000,
    lifetimeSource: 'max-age',
  });

  beforeEach(() => {
    index = new PurgeIndex();
    store = new MemoryStore();
    audit = new PurgeAuditTrail();
    queue = new PurgeJobQueue(index, store);
    api = new PurgeApiHandler(index, queue, audit, store, {
      tokens: [
        {
          token: 'url-only-token',
          scopes: ['purge:url'],
          tenant: 't1',
        },
        {
          token: 'admin-token',
          scopes: ['purge:url', 'purge:prefix', 'purge:tag', 'purge:host', 'purge:tenant'],
        },
      ],
    });
  });

  it('Feature 118: Single-URL purge invalidates exact normalized match and advances generation', () => {
    const e1 = makeEntry('h1', 'https://example.com/api/v1/user');
    const e2 = makeEntry('h2', 'https://example.com/api/v1/user'); // vary variant
    const e3 = makeEntry('h3', 'https://example.com/api/v1/other');

    store.set(e1);
    store.set(e2);
    store.set(e3);

    index.indexEntry(e1, 'https://example.com/api/v1/user');
    index.indexEntry(e2, 'https://example.com/api/v1/user');
    index.indexEntry(e3, 'https://example.com/api/v1/other');

    const genBefore = index.getGeneration('default:url:https://example.com/api/v1/user');
    const res = index.executePurge({ type: 'url', target: 'https://example.com/api/v1/user' }, store);

    expect(res.purgedCount).toBe(2);
    expect(res.generation).toBeGreaterThan(genBefore);
    expect(store.get('h1')).toBeUndefined();
    expect(store.get('h2')).toBeUndefined();
    expect(store.get('h3')).toBeDefined();
  });

  it('Feature 119: Prefix purge purges all objects sharing path prefix within tenant', () => {
    const e1 = makeEntry('h1', 'https://example.com/static/css/app.css');
    const e2 = makeEntry('h2', 'https://example.com/static/js/main.js');
    const e3 = makeEntry('h3', 'https://example.com/api/data');

    store.set(e1);
    store.set(e2);
    store.set(e3);

    index.indexEntry(e1, 'https://example.com/static/css/app.css');
    index.indexEntry(e2, 'https://example.com/static/js/main.js');
    index.indexEntry(e3, 'https://example.com/api/data');

    const res = index.executePurge({ type: 'prefix', target: '/static/' }, store);
    expect(res.purgedCount).toBe(2);
    expect(store.get('h1')).toBeUndefined();
    expect(store.get('h2')).toBeUndefined();
    expect(store.get('h3')).toBeDefined();
  });

  it('Feature 120: Tag purge invalidates objects carrying matched Cache-Tag / Surrogate-Key', () => {
    const e1 = makeEntry('h1', 'https://example.com/news/1');
    const e2 = makeEntry('h2', 'https://example.com/news/2');
    const e3 = makeEntry('h3', 'https://example.com/sports/1');

    store.set(e1);
    store.set(e2);
    store.set(e3);

    index.indexEntry(e1, 'https://example.com/news/1', 'articles news');
    index.indexEntry(e2, 'https://example.com/news/2', 'breaking news');
    index.indexEntry(e3, 'https://example.com/sports/1', 'sports');

    const res = index.executePurge({ type: 'tag', target: 'news' }, store);
    expect(res.purgedCount).toBe(2);
    expect(store.get('h1')).toBeUndefined();
    expect(store.get('h2')).toBeUndefined();
    expect(store.get('h3')).toBeDefined();
  });

  it('Feature 121: Host purge removes all objects belonging to specified host', () => {
    const e1 = makeEntry('h1', 'https://alpha.com/test');
    const e2 = makeEntry('h2', 'https://alpha.com/other');
    const e3 = makeEntry('h3', 'https://beta.com/test');

    store.set(e1);
    store.set(e2);
    store.set(e3);

    index.indexEntry(e1, 'https://alpha.com/test');
    index.indexEntry(e2, 'https://alpha.com/other');
    index.indexEntry(e3, 'https://beta.com/test');

    const res = index.executePurge({ type: 'host', target: 'alpha.com' }, store);
    expect(res.purgedCount).toBe(2);
    expect(store.get('h1')).toBeUndefined();
    expect(store.get('h2')).toBeUndefined();
    expect(store.get('h3')).toBeDefined();
  });

  it('Feature 122: Tenant purge wipes all objects of tenant with strict isolation', () => {
    const e1 = makeEntry('t1-1', 'https://example.com/1', 'tenantA');
    const e2 = makeEntry('t1-2', 'https://example.com/2', 'tenantA');
    const e3 = makeEntry('t2-1', 'https://example.com/1', 'tenantB');

    store.set(e1);
    store.set(e2);
    store.set(e3);

    index.indexEntry(e1, 'https://example.com/1');
    index.indexEntry(e2, 'https://example.com/2');
    index.indexEntry(e3, 'https://example.com/1');

    const res = index.executePurge({ type: 'tenant', target: 'tenantA', tenant: 'tenantA' }, store);
    expect(res.purgedCount).toBe(2);
    expect(store.get('t1-1')).toBeUndefined();
    expect(store.get('t1-2')).toBeUndefined();
    expect(store.get('t2-1')).toBeDefined();
  });

  it('Feature 124: Purge auth denies privilege escalation and enforces tenant scoping', () => {
    // 1. url-only token trying to perform prefix purge -> 403 Forbidden
    const check1 = api.authenticateAndAuthorize('Bearer url-only-token', 'purge:prefix', 't1');
    expect(check1.ok).toBe(false);
    if (!check1.ok) {
      expect(check1.status).toBe(403);
    }

    // 2. url-only token attempting to purge a different tenant -> 403 Forbidden
    const check2 = api.authenticateAndAuthorize('Bearer url-only-token', 'purge:url', 'differentTenant');
    expect(check2.ok).toBe(false);
    if (!check2.ok) {
      expect(check2.status).toBe(403);
    }

    // 3. Admin token with global scope -> Allowed
    const check3 = api.authenticateAndAuthorize('Bearer admin-token', 'purge:tenant', 'anyTenant');
    expect(check3.ok).toBe(true);
  });

  it('Feature 125 & 126: Async purge job submission, status tracking, and idempotency deduplication', () => {
    const job1 = queue.submitJob({
      target: { type: 'prefix', target: '/assets/' },
      idempotencyKey: 'idem-123',
    });

    // Submitting with same idempotency key returns the existing job
    const job2 = queue.submitJob({
      target: { type: 'prefix', target: '/assets/' },
      idempotencyKey: 'idem-123',
    });

    expect(job1.id).toBe(job2.id);

    // Status query
    const fetched = queue.getJob(job1.id);
    expect(fetched).toBeDefined();
    expect(['queued', 'running', 'completed']).toContain(fetched!.state);
  });

  it('Feature 128: Purge audit trail creates verifiable SHA-256 tamper-evident hash chain', () => {
    audit.record({
      actor: 'admin-user',
      tenant: 't1',
      action: 'purge:url',
      scope: 'url',
      target: 'https://example.com/asset.js',
      outcome: 'success',
    });

    audit.record({
      actor: 'system',
      tenant: 't1',
      action: 'purge:tag',
      scope: 'tag',
      target: 'header',
      outcome: 'success',
    });

    const verifyResult = audit.verify();
    expect(verifyResult.valid).toBe(true);

    // Tamper test: mutate an entry
    const entries = (audit as any).entries;
    entries[0].target = 'https://malicious.com/tampered';

    const tamperedResult = audit.verify();
    expect(tamperedResult.valid).toBe(false);
  });
});
