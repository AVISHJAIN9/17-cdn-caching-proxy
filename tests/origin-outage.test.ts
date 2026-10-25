import { describe, it, expect } from 'vitest';
import { ControllableOrigin } from '../src/stress/controllable-origin.js';

describe('Feature 134: Origin outage testing', () => {
  it('handles origin flapping and sustained 5xx faults gracefully', async () => {
    const origin = new ControllableOrigin({ failureRate: 1.0 }); // 100% 500 error
    const url = await origin.start();

    const res = await fetch(`${url}/flapping`);
    expect(res.status).toBe(500);

    // Flap down (drop socket)
    origin.setFlapping(false);
    await expect(fetch(`${url}/flapping`)).rejects.toThrow();

    await origin.stop();
  });
});
