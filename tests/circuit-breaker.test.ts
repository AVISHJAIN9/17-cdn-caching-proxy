import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { CircuitBreaker } from '../src/health/circuit-breaker.js';
import { PoolSelector } from '../src/config/pools.js';
import { createAndStartProxy } from '../src/proxy/index.js';

describe('Feature 61: Circuit breaker', () => {
  let fakeNow: number;
  const getClock = () => fakeNow;
  let activeServers: http.Server[] = [];

  const createServer = (handler: http.RequestListener): Promise<{ server: http.Server; url: string; port: number }> => {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        activeServers.push(server);
        resolve({ server, url: `http://127.0.0.1:${addr.port}`, port: addr.port });
      });
    });
  };

  beforeEach(() => {
    fakeNow = 1_000_000;
  });

  afterEach(async () => {
    await Promise.all(
      activeServers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          })
      )
    );
    activeServers = [];
  });

  describe('State Transitions & Trial Limiting', () => {
    it('transitions from CLOSED to OPEN when consecutive failures reach threshold', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        openDurationMs: 15_000,
        clock: getClock,
      });

      expect(breaker.getState('origin-1')).toBe('CLOSED');
      expect(breaker.allowRequest('origin-1')).toBe(true);

      // Failure 1
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('CLOSED');

      // Failure 2
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('CLOSED');

      // Failure 3 -> opens the circuit
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');
      expect(breaker.allowRequest('origin-1')).toBe(false);
    });

    it('rejects immediately when OPEN with zero upstream attempts allowed', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        openDurationMs: 10_000,
        clock: getClock,
      });

      breaker.recordFailure('origin-1');
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');

      // Multiple checks return false immediately
      expect(breaker.allowRequest('origin-1')).toBe(false);
      expect(breaker.allowRequest('origin-1')).toBe(false);
      expect(breaker.allowRequest('origin-1')).toBe(false);
    });

    it('transitions to HALF_OPEN after open duration and allows exactly the configured trial requests under 50 concurrent attempts', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        openDurationMs: 10_000,
        halfOpenMaxRequests: 1, // Only 1 trial request permitted
        clock: getClock,
      });

      breaker.recordFailure('origin-1');
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');

      // Advance clock past open duration (11s)
      fakeNow += 11_000;

      // Simulate 50 concurrent requests competing for trial slot
      const results: boolean[] = [];
      for (let i = 0; i < 50; i++) {
        results.push(breaker.allowRequest('origin-1'));
      }

      // Exactly 1 request is allowed through as trial request!
      const allowedCount = results.filter((r) => r === true).length;
      const rejectedCount = results.filter((r) => r === false).length;

      expect(allowedCount).toBe(1);
      expect(rejectedCount).toBe(49);
      expect(breaker.getState('origin-1')).toBe('HALF_OPEN');
    });

    it('closes the circuit on a successful trial request', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        openDurationMs: 5_000,
        clock: getClock,
      });

      breaker.recordFailure('origin-1');
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');

      // Advance past open duration
      fakeNow += 6_000;
      expect(breaker.allowRequest('origin-1')).toBe(true);
      expect(breaker.getState('origin-1')).toBe('HALF_OPEN');

      // Trial succeeds!
      breaker.recordSuccess('origin-1');
      expect(breaker.getState('origin-1')).toBe('CLOSED');
      expect(breaker.allowRequest('origin-1')).toBe(true);
      expect(breaker.allowRequest('origin-1')).toBe(true);
    });

    it('reopens the circuit immediately on a failed trial request', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        openDurationMs: 5_000,
        clock: getClock,
      });

      breaker.recordFailure('origin-1');
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');

      fakeNow += 6_000;
      expect(breaker.allowRequest('origin-1')).toBe(true);
      expect(breaker.getState('origin-1')).toBe('HALF_OPEN');

      // Trial fails!
      breaker.recordFailure('origin-1');
      expect(breaker.getState('origin-1')).toBe('OPEN');
      expect(breaker.allowRequest('origin-1')).toBe(false);
    });

    it('maintains independent circuit breaker states per origin', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        clock: getClock,
      });

      breaker.recordFailure('origin-1');
      breaker.recordFailure('origin-1');

      expect(breaker.getState('origin-1')).toBe('OPEN');
      expect(breaker.allowRequest('origin-1')).toBe(false);

      expect(breaker.getState('origin-2')).toBe('CLOSED');
      expect(breaker.allowRequest('origin-2')).toBe(true);
    });
  });

  describe('End-to-End Proxy Circuit Breaking', () => {
    it('rejects immediately with 502/503 when circuit is OPEN, producing zero upstream hits', async () => {
      let upstreamHits = 0;
      const srv = await createServer((req, res) => {
        upstreamHits++;
        res.writeHead(200);
        res.end('hello');
      });

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        openDurationMs: 60_000,
      });

      // Trip the breaker manually
      breaker.recordFailure('srv');
      breaker.recordFailure('srv');
      expect(breaker.getState('srv')).toBe('OPEN');

      const poolSelector = new PoolSelector();
      // Supply breaker check to availability hook
      poolSelector.isAvailable = (id) => breaker.allowRequest(id);

      const proxy = await createAndStartProxy({
        port: 0,
        poolSelector,
        originsConfig: {
          origins: { srv: { url: srv.url } },
          defaultOrigin: 'srv',
          pools: {
            mainPool: { members: [{ origin: 'srv' }] },
          },
          routes: [{ pathPrefix: '/api', origin: 'mainPool' }],
        },
      });

      try {
        const res = await fetch(`http://127.0.0.1:${proxy.httpPort}/api/test`);
        expect(res.status).toBe(502);

        // Crucial requirement: assert zero requests reached the upstream server!
        expect(upstreamHits).toBe(0);
      } finally {
        await proxy.close();
      }
    });
  });
});
