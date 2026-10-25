import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActiveHealthChecker } from '../src/health/active.js';
import http from 'node:http';

describe('Feature 59: Active health checks', () => {
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

  describe('Threshold Hysteresis', () => {
    it('applies healthy and unhealthy thresholds so one single probe result never flips state', async () => {
      let probeStatus = 200;
      const sendProbe = vi.fn(async () => ({ status: probeStatus }));

      const checker = new ActiveHealthChecker({
        origins: { 'origin-1': { url: 'http://127.0.0.1:8001' } },
        unhealthyThreshold: 3,
        healthyThreshold: 2,
        sendProbe,
      });

      expect(checker.isHealthy('origin-1')).toBe(true);

      // 1 failure: stays healthy
      probeStatus = 500;
      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(true);
      expect(checker.getConsecutiveFailures('origin-1')).toBe(1);

      // 2 failures: still stays healthy
      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(true);
      expect(checker.getConsecutiveFailures('origin-1')).toBe(2);

      // 3 failures: reaches unhealthyThreshold -> flips to unhealthy
      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(false);
      expect(checker.getConsecutiveFailures('origin-1')).toBe(3);

      // 1 success: does NOT flip back to healthy immediately
      probeStatus = 200;
      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(false);
      expect(checker.getConsecutiveSuccesses('origin-1')).toBe(1);

      // 2nd success: reaches healthyThreshold -> flips back to healthy
      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(true);
      expect(checker.getConsecutiveSuccesses('origin-1')).toBe(2);
    });
  });

  describe('Probe Timeouts and Failures', () => {
    it('counts a probe timeout as a failure', async () => {
      const sendProbe = vi.fn(async () => {
        const err: any = new Error('Probe timed out');
        err.code = 'ETIMEDOUT';
        return { error: err };
      });

      const checker = new ActiveHealthChecker({
        origins: { 'origin-1': { url: 'http://127.0.0.1:8001' } },
        unhealthyThreshold: 2,
        sendProbe,
      });

      await checker.probeOrigin('origin-1');
      expect(checker.getConsecutiveFailures('origin-1')).toBe(1);
      expect(checker.isHealthy('origin-1')).toBe(true);

      await checker.probeOrigin('origin-1');
      expect(checker.getConsecutiveFailures('origin-1')).toBe(2);
      expect(checker.isHealthy('origin-1')).toBe(false);
    });

    it('counts non-expected status codes as failures', async () => {
      const sendProbe = vi.fn(async () => ({ status: 503 }));

      const checker = new ActiveHealthChecker({
        origins: { 'origin-1': { url: 'http://127.0.0.1:8001' } },
        expectedStatus: [200, 204],
        unhealthyThreshold: 1,
        sendProbe,
      });

      await checker.probeOrigin('origin-1');
      expect(checker.isHealthy('origin-1')).toBe(false);
    });
  });

  describe('Concurrency & Non-overlapping Probes', () => {
    it('never runs overlapping probes for the same origin', async () => {
      let activeProbeCount = 0;
      let maxConcurrentProbes = 0;

      const sendProbe = vi.fn(async () => {
        activeProbeCount++;
        maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbeCount);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeProbeCount--;
        return { status: 200 };
      });

      const checker = new ActiveHealthChecker({
        origins: { 'origin-1': { url: 'http://127.0.0.1:8001' } },
        sendProbe,
      });

      // Launch 3 probe calls simultaneously
      const [p1, p2, p3] = [
        checker.probeOrigin('origin-1'),
        checker.probeOrigin('origin-1'),
        checker.probeOrigin('origin-1'),
      ];

      await Promise.all([p1, p2, p3]);

      // Because probes do not overlap, concurrent probe invocations while in-flight are skipped or serialized
      expect(maxConcurrentProbes).toBe(1);
    });
  });

  describe('Timer Lifecycle and Clean Shutdown', () => {
    it('runs probes at configured interval and clears all timers on stop() without leaks', async () => {
      let probeCount = 0;
      const sendProbe = vi.fn(async () => {
        probeCount++;
        return { status: 200 };
      });

      const checker = new ActiveHealthChecker({
        origins: {
          'origin-1': { url: 'http://127.0.0.1:8001' },
          'origin-2': { url: 'http://127.0.0.1:8002' },
        },
        intervalMs: 25,
        sendProbe,
      });

      checker.start();

      // Wait 70ms (should fire ~2 ticks per origin)
      await new Promise((resolve) => setTimeout(resolve, 70));
      const countBeforeStop = probeCount;
      expect(countBeforeStop).toBeGreaterThanOrEqual(2);

      // Stop must clear all timers
      checker.stop();

      // Wait another 50ms and assert no additional probes run
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(probeCount).toBe(countBeforeStop);
    });
  });

  describe('Real HTTP Endpoint Probing without Cache Contamination', () => {
    it('executes direct HTTP probe to real origin endpoint without touching cache store', async () => {
      let probeHits = 0;
      const { url } = await createServer((req, res) => {
        if (req.url === '/healthz') {
          probeHits++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const checker = new ActiveHealthChecker({
        origins: { 'primary': { url } },
        path: '/healthz',
        unhealthyThreshold: 2,
        healthyThreshold: 2,
      });

      // Probe against real HTTP server
      await checker.probeOrigin('primary');
      expect(probeHits).toBe(1);
      expect(checker.isHealthy('primary')).toBe(true);

      checker.stop();
    });
  });
});
