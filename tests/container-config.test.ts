import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ProxyListener } from '../src/proxy/listener.js';

describe('Feature 142: Container deployment and graceful shutdown', () => {
  const rootDir = path.resolve(__dirname, '..');

  it('asserts Dockerfile multi-stage, non-root, pinned digest/version, and healthcheck invariants', () => {
    const dockerfilePath = path.join(rootDir, 'Dockerfile');
    expect(fs.existsSync(dockerfilePath)).toBe(true);

    const content = fs.readFileSync(dockerfilePath, 'utf8');
    const lines = content.split('\n');

    // 1. Multi-stage build
    const fromStages = lines.filter((l) => /^FROM\s+/i.test(l.trim()));
    expect(fromStages.length).toBeGreaterThanOrEqual(2);
    expect(fromStages.some((l) => /AS\s+builder/i.test(l))).toBe(true);
    expect(fromStages.some((l) => /AS\s+runner/i.test(l))).toBe(true);

    // 2. No 'latest' tag allowed
    for (const fromLine of fromStages) {
      expect(fromLine.toLowerCase()).not.toContain(':latest');
    }

    // 3. Non-root USER declaration
    const userLine = lines.find((l) => /^USER\s+/i.test(l.trim()));
    expect(userLine).toBeDefined();
    expect(userLine).not.toMatch(/^USER\s+0(\s|$)/i);
    expect(userLine).not.toMatch(/^USER\s+root(\s|$)/i);

    // 4. HEALTHCHECK present
    const hasHealthcheck = lines.some((l) => /^HEALTHCHECK\s+/i.test(l.trim()));
    expect(hasHealthcheck).toBe(true);

    // 5. STOPSIGNAL SIGTERM present
    const hasStopSignal = lines.some((l) => /^STOPSIGNAL\s+SIGTERM/i.test(l.trim()));
    expect(hasStopSignal).toBe(true);

    // 6. No hardcoded credentials/secrets in build args or env
    for (const line of lines) {
      if (/^(ARG|ENV)\s+/i.test(line)) {
        expect(line).not.toMatch(/(password|secret|apikey|token)\s*=\s*['"][^'"]+['"]/i);
      }
    }
  });

  it('asserts docker-compose.yml services, healthchecks, read-only root, and resource limits', () => {
    const composePath = path.join(rootDir, 'docker-compose.yml');
    expect(fs.existsSync(composePath)).toBe(true);

    const content = fs.readFileSync(composePath, 'utf8');

    // Services exist
    expect(content).toContain('origin:');
    expect(content).toContain('proxy:');
    expect(content).toContain('prometheus:');

    // Proxy read-only root and volumes
    expect(content).toContain('read_only: true');
    expect(content).toContain('tmpfs:');
    expect(content).toContain('/tmp');
    expect(content).toContain('cache_data:/var/cache/cdn');

    // Resource limits
    expect(content).toContain('limits:');
    expect(content).toContain('memory: 512M');

    // Healthchecks and dependencies
    expect(content).toContain('healthcheck:');
    expect(content).toContain('condition: service_healthy');
  });

  it('verifies graceful shutdown on SIGTERM: stops accepting, drains in-flight requests, and closes cleanly', async () => {
    let inFlightCompleted = false;

    let reqStartedResolve: () => void = () => {};
    const reqStarted = new Promise<void>((r) => {
      reqStartedResolve = r;
    });

    // Create ProxyListener on ephemeral port
    const listener = new ProxyListener(
      {
        listeners: {
          http: { host: '127.0.0.1', port: 0 },
        },
        shutdownGracePeriodMs: 2000,
        handleSignals: false, // We trigger stop() directly simulating SIGTERM
      },
      async (req, res) => {
        if (req.url === '/slow-transfer') {
          reqStartedResolve();
          // Simulate an in-flight transfer that takes 100ms
          await new Promise((r) => setTimeout(r, 100));
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow transfer completed cleanly');
          inFlightCompleted = true;
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      }
    );

    await listener.start();
    const port = listener.httpPort!;
    expect(port).toBeGreaterThan(0);

    // Launch slow request
    const requestPromise = new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/slow-transfer`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }).on('error', reject);
    });

    // Wait until request has actually arrived at server before triggering stop()
    await reqStarted;

    // While request is in flight, stop() begins drain
    const stopPromise = listener.stop();

    // Verify in-flight request completes successfully with 200 OK during shutdown
    const response = await requestPromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('slow transfer completed cleanly');
    expect(inFlightCompleted).toBe(true);

    // Stop completes cleanly
    await stopPromise;

    // Verify server no longer accepts new requests
    await expect(
      new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/slow-transfer`, resolve);
        req.on('error', reject);
      })
    ).rejects.toThrow();
  });
});
