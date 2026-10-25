import { describe, it, expect, beforeEach } from 'vitest';
import { PassiveHealthChecker, isOriginFailure } from '../src/health/passive.js';

describe('Feature 60: Passive health checks', () => {
  let fakeNow: number;
  const getClock = () => fakeNow;

  beforeEach(() => {
    fakeNow = 1_000_000;
  });

  describe('Failure Classification', () => {
    it('classifies 5xx status codes as origin failures', () => {
      expect(isOriginFailure({ status: 500 })).toBe(true);
      expect(isOriginFailure({ status: 502 })).toBe(true);
      expect(isOriginFailure({ status: 503 })).toBe(true);
      expect(isOriginFailure({ status: 504 })).toBe(true);
    });

    it('classifies upstream connection, DNS, TLS, and timeout errors as origin failures', () => {
      expect(isOriginFailure({ code: 'ECONNREFUSED' })).toBe(true);
      expect(isOriginFailure({ code: 'ENOTFOUND' })).toBe(true);
      expect(isOriginFailure({ code: 'EHOSTUNREACH' })).toBe(true);
      expect(isOriginFailure({ code: 'ECONNRESET' })).toBe(true);
      expect(isOriginFailure({ code: 'UPSTREAM_CONNECT_TIMEOUT' })).toBe(true);
      expect(isOriginFailure({ code: 'UPSTREAM_HEADERS_TIMEOUT' })).toBe(true);
      expect(isOriginFailure({ code: 'UPSTREAM_IDLE_TIMEOUT' })).toBe(true);
      expect(isOriginFailure({ code: 'UPSTREAM_TLS_ERROR' })).toBe(true);
    });

    it('does not classify client 4xx errors as origin failures', () => {
      expect(isOriginFailure({ status: 400 })).toBe(false);
      expect(isOriginFailure({ status: 401 })).toBe(false);
      expect(isOriginFailure({ status: 403 })).toBe(false);
      expect(isOriginFailure({ status: 404 })).toBe(false);
      expect(isOriginFailure({ status: 429 })).toBe(false);
    });

    it('does not classify client aborts as origin failures', () => {
      expect(isOriginFailure({ code: 'CLIENT_ABORTED' })).toBe(false);
      expect(isOriginFailure({ code: 'ERR_STREAM_PREMATURE_CLOSE' })).toBe(false);
      expect(isOriginFailure({ clientAbort: true })).toBe(false);
    });

    it('does not classify 2xx and 3xx responses as failures', () => {
      expect(isOriginFailure({ status: 200 })).toBe(false);
      expect(isOriginFailure({ status: 304 })).toBe(false);
    });
  });

  describe('Consecutive Failure Tracking and Health Transitions', () => {
    it('marks origin unhealthy after N consecutive failures', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 3,
        failureWindowMs: 30_000,
        cooldownMs: 10_000,
        clock: getClock,
      });

      expect(checker.isHealthy('origin-a')).toBe(true);

      // Failure 1
      checker.recordOutcome('origin-a', { status: 502 });
      expect(checker.isHealthy('origin-a')).toBe(true);

      // Failure 2
      checker.recordOutcome('origin-a', { code: 'ECONNREFUSED' });
      expect(checker.isHealthy('origin-a')).toBe(true);

      // Failure 3 -> triggers unhealthy
      checker.recordOutcome('origin-a', { code: 'UPSTREAM_HEADERS_TIMEOUT' });
      expect(checker.isHealthy('origin-a')).toBe(false);
    });

    it('resets consecutive failure counter on a success', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 3,
        failureWindowMs: 30_000,
        cooldownMs: 10_000,
        clock: getClock,
      });

      checker.recordOutcome('origin-a', { status: 500 });
      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(2);

      // Success resets counter
      checker.recordOutcome('origin-a', { status: 200 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(0);
      expect(checker.isHealthy('origin-a')).toBe(true);

      // Two more failures are not enough to trip threshold of 3
      checker.recordOutcome('origin-a', { status: 503 });
      checker.recordOutcome('origin-a', { status: 503 });
      expect(checker.isHealthy('origin-a')).toBe(true);
    });

    it('slides the error-rate window on a fake clock and ages out old failures', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 3,
        failureWindowMs: 10_000, // 10s window
        cooldownMs: 5_000,
        clock: getClock,
      });

      // Failure 1 at t=0
      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(1);

      // Failure 2 at t=2s
      fakeNow += 2_000;
      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(2);

      // Advance clock past failureWindowMs (11 seconds)
      fakeNow += 11_000; // t = 13s

      // Old failures aged out of the sliding window
      expect(checker.getConsecutiveFailures('origin-a')).toBe(0);

      // A single failure now does not trip the breaker
      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(1);
      expect(checker.isHealthy('origin-a')).toBe(true);
    });

    it('recovers an unhealthy origin after cooldown period elapses', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 2,
        cooldownMs: 8_000,
        clock: getClock,
      });

      checker.recordOutcome('origin-a', { status: 500 });
      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.isHealthy('origin-a')).toBe(false);

      // Advance time by 5s (less than 8s cooldown)
      fakeNow += 5_000;
      expect(checker.isHealthy('origin-a')).toBe(false);

      // Advance time past cooldown (another 4s, total 9s)
      fakeNow += 4_000;
      expect(checker.isHealthy('origin-a')).toBe(true);
    });

    it('ignores client aborts and 4xx responses without affecting failure counts', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 2,
        clock: getClock,
      });

      checker.recordOutcome('origin-a', { status: 500 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(1);

      // 404 should neither increment failures nor reset consecutive count
      checker.recordOutcome('origin-a', { status: 404 });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(1);
      expect(checker.isHealthy('origin-a')).toBe(true);

      // Client abort should neither increment failures nor reset consecutive count
      checker.recordOutcome('origin-a', { clientAbort: true });
      expect(checker.getConsecutiveFailures('origin-a')).toBe(1);
      expect(checker.isHealthy('origin-a')).toBe(true);
    });

    it('maintains strict failure counters per origin', () => {
      const checker = new PassiveHealthChecker({
        consecutiveFailures: 2,
        clock: getClock,
      });

      checker.recordOutcome('origin-1', { status: 500 });
      checker.recordOutcome('origin-2', { status: 200 });
      checker.recordOutcome('origin-1', { status: 502 });

      expect(checker.isHealthy('origin-1')).toBe(false);
      expect(checker.isHealthy('origin-2')).toBe(true);

      expect(checker.getConsecutiveFailures('origin-1')).toBe(2);
      expect(checker.getConsecutiveFailures('origin-2')).toBe(0);
    });
  });
});
