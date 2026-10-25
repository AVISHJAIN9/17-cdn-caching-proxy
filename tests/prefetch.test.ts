import { describe, it, expect } from 'vitest';
import { PrefetchManager } from '../src/warm/warm-prefetch.js';

describe('Feature 130: Prefetch API', () => {
  it('parses Link headers and enqueues prefetch targets with loop suppression', () => {
    const manager = new PrefetchManager();
    const linkHeader = '<https://example.com/next.html>; rel="prefetch", <https://example.com/style.css>; rel=preload';

    const hints = manager.parseLinkHints(linkHeader);
    expect(hints).toEqual(['https://example.com/next.html', 'https://example.com/style.css']);

    expect(manager.enqueuePrefetch(hints[0], 10)).toBe(true);
    // Duplicate suppression
    expect(manager.enqueuePrefetch(hints[0], 5)).toBe(false);

    expect(manager.issuedCount).toBe(1);

    // Record later cache hit on prefetched URL
    manager.recordLaterHit(hints[0]);
    expect(manager.usefulCount).toBe(1);
  });
});
