import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createAndStartProxy } from '../src/proxy/index.js';
import { MemoryStore } from '../src/cache/memory-store.js';
import { DiskStore } from '../src/cache/disk-store.js';
import type { ProxyListener } from '../src/proxy/listener.js';

describe('Feature 90: Tenant isolation', () => {
  let originServer: http.Server;
  let originPort: number;
  let originRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let originCounter = 0;
  let proxy: ProxyListener;
  let proxyPort: number;
  let store: MemoryStore;
  let tempDiskDir: string;

  beforeEach(async () => {
    originRequests = [];
    originCounter = 0;
    originServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        originRequests.push({ url: req.url || '/', headers: req.headers, body });
        originCounter++;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          ETag: `"v-${originCounter}"`,
        });
        res.end(JSON.stringify({ counter: originCounter, tenantHeader: req.headers['x-tenant-id'] || 'none' }));
      });
    });

    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = (originServer.address() as any).port;
    store = new MemoryStore({ maxObjectBytes: 5 * 1024 * 1024 });
    tempDiskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-disk-test-'));
  });

  afterEach(async () => {
    if (proxy) await proxy.stop();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
    try {
      if (fs.existsSync(tempDiskDir)) {
        fs.rmSync(tempDiskDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('ensures cache lookup isolation: cached response for Tenant A is never served to Tenant B', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    // 1. Tenant A requests /resource -> Cache MISS, fetched from origin
    const resA1 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { 'x-tenant-id': 'tenant-alpha' },
    });
    expect(resA1.status).toBe(200);
    expect(resA1.headers.get('x-cache')).toBe('MISS');
    const dataA1 = await resA1.json();
    expect(dataA1.counter).toBe(1);
    expect(originCounter).toBe(1);

    // 2. Tenant A requests /resource again -> Cache HIT
    const resA2 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { 'x-tenant-id': 'tenant-alpha' },
    });
    expect(resA2.status).toBe(200);
    expect(resA2.headers.get('x-cache')).toBe('HIT');
    const dataA2 = await resA2.json();
    expect(dataA2.counter).toBe(1);
    expect(originCounter).toBe(1); // Origin not called

    // 3. Tenant B requests identical /resource -> Cache MISS! Never serves Tenant A's cache
    const resB1 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { 'x-tenant-id': 'tenant-beta' },
    });
    expect(resB1.status).toBe(200);
    expect(resB1.headers.get('x-cache')).toBe('MISS');
    const dataB1 = await resB1.json();
    expect(dataB1.counter).toBe(2);
    expect(originCounter).toBe(2); // Origin called for Tenant B

    // 4. Tenant B requests /resource again -> Cache HIT for Tenant B
    const resB2 = await fetch(`http://127.0.0.1:${proxyPort}/resource`, {
      headers: { 'x-tenant-id': 'tenant-beta' },
    });
    expect(resB2.status).toBe(200);
    expect(resB2.headers.get('x-cache')).toBe('HIT');
    const dataB2 = await resB2.json();
    expect(dataB2.counter).toBe(2); // Retains Tenant B's response
    expect(originCounter).toBe(2);
  });

  it('ensures authenticated response isolation across different API key tenants', async () => {
    const rawKeyA = 'cdn_secret_key_alpha_12345';
    const rawKeyB = 'cdn_secret_key_beta_67890';
    const hashKeyA = crypto.createHash('sha256').update(rawKeyA).digest('hex');
    const hashKeyB = crypto.createHash('sha256').update(rawKeyB).digest('hex');

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      apiKeyAuth: {
        keys: [
          { id: 'key-a', hashedKey: hashKeyA, tenantId: 'tenant-alpha' },
          { id: 'key-b', hashedKey: hashKeyB, tenantId: 'tenant-beta' },
        ],
      },
    });
    proxyPort = proxy.httpPort!;

    // 1. Tenant A requests /secure-data with Key A -> MISS, stored in Tenant A namespace
    const resA = await fetch(`http://127.0.0.1:${proxyPort}/secure-data`, {
      headers: { 'x-api-key': rawKeyA },
    });
    expect(resA.status).toBe(200);
    expect(resA.headers.get('x-cache')).toBe('MISS');
    const dataA = await resA.json();
    expect(dataA.counter).toBe(1);

    // 2. Tenant A again -> HIT
    const resA2 = await fetch(`http://127.0.0.1:${proxyPort}/secure-data`, {
      headers: { 'x-api-key': rawKeyA },
    });
    expect(resA2.status).toBe(200);
    expect(resA2.headers.get('x-cache')).toBe('HIT');

    // 3. Tenant B requests same URL with Key B -> MISS (must not leak Tenant A)
    const resB = await fetch(`http://127.0.0.1:${proxyPort}/secure-data`, {
      headers: { 'x-api-key': rawKeyB },
    });
    expect(resB.status).toBe(200);
    expect(resB.headers.get('x-cache')).toBe('MISS');
    const dataB = await resB.json();
    expect(dataB.counter).toBe(2);

    // 4. Tenant B tries to spoof x-tenant-id header -> authenticated tenant takes precedence
    const resSpoof = await fetch(`http://127.0.0.1:${proxyPort}/secure-data`, {
      headers: {
        'x-api-key': rawKeyB,
        'x-tenant-id': 'tenant-alpha', // Attempt to spoof Tenant A!
      },
    });
    expect(resSpoof.status).toBe(200);
    expect(resSpoof.headers.get('x-cache')).toBe('HIT');
    const dataSpoof = await resSpoof.json();
    expect(dataSpoof.counter).toBe(2); // Still gets Tenant B's data, NOT Tenant A's data!
  });

  it('ensures authenticated response isolation across JWT tokens with different tenant IDs', async () => {
    const jwtSecret = Buffer.from('shared-jwt-secret-for-tenants-key-longer-than-32-bytes');
    const nowSec = Math.floor(Date.now() / 1000);

    const makeJwt = (payload: any) => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const input = `${header}.${claims}`;
      const sig = crypto.createHmac('sha256', jwtSecret).update(input).digest('base64url');
      return `${input}.${sig}`;
    };

    const tokenA = makeJwt({ sub: 'user-a', tid: 'tenant-a', exp: nowSec + 3600, iss: 'auth.corp' });
    const tokenB = makeJwt({ sub: 'user-b', tid: 'tenant-b', exp: nowSec + 3600, iss: 'auth.corp' });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
      jwtAuth: {
        enabled: true,
        secret: jwtSecret,
        allowedAlgorithms: ['HS256'],
        issuer: 'auth.corp',
      },
    });
    proxyPort = proxy.httpPort!;

    // Request from Tenant A -> BYPASS (initial request with Authorization header per RFC 9111)
    const resA = await fetch(`http://127.0.0.1:${proxyPort}/jwt-data`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resA.status).toBe(200);
    expect(resA.headers.get('x-cache')).toBe('BYPASS');

    // Wait brief tick for CacheTeeStream to store into Tenant A namespace
    await new Promise((r) => setTimeout(r, 20));

    // Request from Tenant B -> BYPASS (isolated namespace, not in Tenant B cache)
    const resB = await fetch(`http://127.0.0.1:${proxyPort}/jwt-data`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(resB.status).toBe(200);
    expect(resB.headers.get('x-cache')).toBe('BYPASS');

    // Request from Tenant A again -> HIT (served from Tenant A cache because origin returned public Cache-Control)
    const resA2 = await fetch(`http://127.0.0.1:${proxyPort}/jwt-data`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(resA2.status).toBe(200);
    expect(resA2.headers.get('x-cache')).toBe('HIT');
  });

  it('isolates tenant quota and eviction: Tenant A exceeding quota never evicts Tenant B', async () => {
    // Configure store with maxEntries quota: 2 for tenant-a, 5 for tenant-b
    const quotaStore = new MemoryStore({
      maxTotalBytes: 50 * 1024 * 1024,
      tenantQuotas: {
        'tenant-a': { maxEntries: 2 },
        'tenant-b': { maxEntries: 5 },
      },
      evictionPolicy: 'lru',
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store: quotaStore,
    });
    proxyPort = proxy.httpPort!;

    // 1. Tenant B inserts entry 1 & 2
    const resB1 = await fetch(`http://127.0.0.1:${proxyPort}/b-1`, { headers: { 'x-tenant-id': 'tenant-b' } });
    await resB1.text();
    const resB2 = await fetch(`http://127.0.0.1:${proxyPort}/b-2`, { headers: { 'x-tenant-id': 'tenant-b' } });
    await resB2.text();
    await new Promise((r) => setTimeout(r, 20));

    // Verify Tenant B has 2 entries in store
    const statsBInit = quotaStore.getTenantStats('tenant-b');
    expect(statsBInit.entries).toBe(2);

    // 2. Tenant A inserts entry 1 & 2 (fills quota of 2)
    const resA1 = await fetch(`http://127.0.0.1:${proxyPort}/a-1`, { headers: { 'x-tenant-id': 'tenant-a' } });
    await resA1.text();
    const resA2 = await fetch(`http://127.0.0.1:${proxyPort}/a-2`, { headers: { 'x-tenant-id': 'tenant-a' } });
    await resA2.text();
    await new Promise((r) => setTimeout(r, 20));

    const statsAInit = quotaStore.getTenantStats('tenant-a');
    expect(statsAInit.entries).toBe(2);

    // 3. Tenant A inserts entry 3 -> Exceeds Tenant A's quota, triggers eviction in Tenant A
    const resA3 = await fetch(`http://127.0.0.1:${proxyPort}/a-3`, { headers: { 'x-tenant-id': 'tenant-a' } });
    await resA3.text();
    await new Promise((r) => setTimeout(r, 20));

    // Tenant A entries should still be capped at 2
    const statsAFinal = quotaStore.getTenantStats('tenant-a');
    expect(statsAFinal.entries).toBe(2);

    // Crucial: Tenant B entries MUST NOT have been evicted!
    const statsBFinal = quotaStore.getTenantStats('tenant-b');
    expect(statsBFinal.entries).toBe(2);

    // Verify Tenant B's entries still return HIT
    const hitB1 = await fetch(`http://127.0.0.1:${proxyPort}/b-1`, { headers: { 'x-tenant-id': 'tenant-b' } });
    expect(hitB1.headers.get('x-cache')).toBe('HIT');
    const hitB2 = await fetch(`http://127.0.0.1:${proxyPort}/b-2`, { headers: { 'x-tenant-id': 'tenant-b' } });
    expect(hitB2.headers.get('x-cache')).toBe('HIT');

    // Meanwhile Tenant A's oldest entry (a-1) was evicted
    const missA1 = await fetch(`http://127.0.0.1:${proxyPort}/a-1`, { headers: { 'x-tenant-id': 'tenant-a' } });
    expect(missA1.headers.get('x-cache')).toBe('MISS');
  });

  it('isolates namespace purge: purging Tenant A does not invalidate Tenant B entries', async () => {
    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store,
    });
    proxyPort = proxy.httpPort!;

    // Seed entries for Tenant A and Tenant B
    const rA = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-a' } });
    await rA.text();
    const rB = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-b' } });
    await rB.text();
    await new Promise((r) => setTimeout(r, 20));

    // Verify both hit cache
    const hitA = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-a' } });
    expect(hitA.headers.get('x-cache')).toBe('HIT');
    const hitB = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-b' } });
    expect(hitB.headers.get('x-cache')).toBe('HIT');

    // Purge Tenant A only
    const purgedCount = store.purgeNamespace('tenant-a');
    expect(purgedCount).toBe(1);

    // Tenant A is now a MISS
    const missA = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-a' } });
    expect(missA.headers.get('x-cache')).toBe('MISS');

    // Tenant B remains a HIT!
    const stillHitB = await fetch(`http://127.0.0.1:${proxyPort}/shared`, { headers: { 'x-tenant-id': 'tenant-b' } });
    expect(stillHitB.headers.get('x-cache')).toBe('HIT');
  });

  it('isolates tenant paths on disk when isolateTenantPaths is enabled', async () => {
    const diskStore = new DiskStore({
      dirPath: tempDiskDir,
      maxTotalBytes: 50 * 1024 * 1024,
      isolateTenantPaths: true,
    });

    proxy = await createAndStartProxy({
      httpHost: '127.0.0.1',
      httpPort: 0,
      originUrl: `http://127.0.0.1:${originPort}`,
      store: diskStore,
    });
    proxyPort = proxy.httpPort!;

    // Store responses for Tenant A and Tenant B
    const fA = await fetch(`http://127.0.0.1:${proxyPort}/file-a`, { headers: { 'x-tenant-id': 'tenant-a' } });
    await fA.text();
    const fB = await fetch(`http://127.0.0.1:${proxyPort}/file-b`, { headers: { 'x-tenant-id': 'tenant-b' } });
    await fB.text();
    await new Promise((r) => setTimeout(r, 30));

    // Check directory structure on disk: tenant-a and tenant-b subdirectories must exist
    const tenantADir = path.join(tempDiskDir, 'tenant-a');
    const tenantBDir = path.join(tempDiskDir, 'tenant-b');

    expect(fs.existsSync(tenantADir)).toBe(true);
    expect(fs.existsSync(tenantBDir)).toBe(true);

    const filesA = fs.readdirSync(tenantADir).filter((f) => f.endsWith('.cache'));
    const filesB = fs.readdirSync(tenantBDir).filter((f) => f.endsWith('.cache'));

    expect(filesA.length).toBe(1);
    expect(filesB.length).toBe(1);

    // Rebuild index from disk on a new DiskStore instance and verify isolation is preserved
    const recoveredDiskStore = new DiskStore({
      dirPath: tempDiskDir,
      maxTotalBytes: 50 * 1024 * 1024,
      isolateTenantPaths: true,
    });

    const statsARecovered = recoveredDiskStore.getTenantStats('tenant-a');
    const statsBRecovered = recoveredDiskStore.getTenantStats('tenant-b');
    expect(statsARecovered.entries).toBe(1);
    expect(statsBRecovered.entries).toBe(1);

    // Purge Tenant A on disk store
    const purgedDiskCount = recoveredDiskStore.purgeNamespace('tenant-a');
    expect(purgedDiskCount).toBe(1);

    // Tenant A dir should be cleared, Tenant B dir and files remain untouched
    expect(fs.existsSync(path.join(tempDiskDir, 'tenant-b'))).toBe(true);
    expect(fs.readdirSync(tenantBDir).filter((f) => f.endsWith('.cache')).length).toBe(1);
    expect(recoveredDiskStore.getTenantStats('tenant-b').entries).toBe(1);
  });
});
