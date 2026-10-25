import { FakeClock } from '../../src/util/clock.js';

export function createFakeClockTime(initialEpochMs: number = 784111777000) {
  const clock = new FakeClock(initialEpochMs);
  return {
    clock,
    now: () => clock.now(),
    advance: (ms: number) => clock.advance(ms),
    advanceSeconds: (sec: number) => clock.advance(sec * 1000),
    set: (ms: number) => clock.set(ms),
    msBefore: (sec: number) => clock.now() - sec * 1000,
    msAfter: (sec: number) => clock.now() + sec * 1000,
  };
}
