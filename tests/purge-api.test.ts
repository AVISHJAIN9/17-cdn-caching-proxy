import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { PurgeIndex } from '../src/purge/index-store.js';
import { PurgeAuditTrail } from '../src/purge/audit.js';
import { PurgeJobQueue } from '../src/purge/jobs.js';
import { PurgeApiHandler } from '../src/purge/api.js';

describe('Feature 123: Purge API', () => {
  it('handles synchronous single-URL purge requests and async wide purge requests', async () => {
    const index = new PurgeIndex();
    const audit = new PurgeAuditTrail();
    const queue = new PurgeJobQueue(index);
    const api = new PurgeApiHandler(index, queue, audit, undefined, {
      tokens: [
        {
          token: 'sec-tok',
          scopes: ['purge:url', 'purge:prefix', 'purge:tag', 'purge:host', 'purge:tenant'],
        },
      ],
    });

    const server = http.createServer((req, res) => {
      api.handleRequest(req, res);
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;

    // Single-URL sync purge
    const resSync = await fetch(`http://127.0.0.1:${port}/admin/api/v1/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sec-tok',
      },
      body: JSON.stringify({ type: 'url', target: 'http://example.com/item' }),
    });
    expect(resSync.status).toBe(200);

    // Prefix async purge
    const resAsync = await fetch(`http://127.0.0.1:${port}/admin/api/v1/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sec-tok',
      },
      body: JSON.stringify({ type: 'prefix', target: '/static/' }),
    });
    expect(resAsync.status).toBe(202);

    await new Promise<void>((r) => server.close(() => r()));
  });
});
