import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlidingWindowRateLimiter } from '../../src/primitives/rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows operations under the limit', () => {
    const limiter = new SlidingWindowRateLimiter({ window: 60_000, maxOps: 3 });
    expect(limiter.getWaitTime()).toBe(0);
    limiter.record();
    expect(limiter.getWaitTime()).toBe(0);
    limiter.record();
    expect(limiter.getWaitTime()).toBe(0);
    limiter.record();
  });

  it('returns wait time when limit exceeded', () => {
    const limiter = new SlidingWindowRateLimiter({ window: 60_000, maxOps: 2 });
    limiter.record();
    limiter.record();
    // Now at limit — next should wait
    const wait = limiter.getWaitTime();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60_000);
  });

  it('window expires and frees slots', () => {
    const limiter = new SlidingWindowRateLimiter({ window: 1000, maxOps: 1 });
    limiter.record();
    expect(limiter.getWaitTime()).toBeGreaterThan(0);

    vi.advanceTimersByTime(1001);
    expect(limiter.getWaitTime()).toBe(0);
  });

  it('evicts old entries on getWaitTime', () => {
    const limiter = new SlidingWindowRateLimiter({ window: 1000, maxOps: 2 });
    limiter.record();
    vi.advanceTimersByTime(500);
    limiter.record();
    vi.advanceTimersByTime(600);
    // First record expired, second still alive → 1 slot used, 1 available
    expect(limiter.getWaitTime()).toBe(0);
  });
});
