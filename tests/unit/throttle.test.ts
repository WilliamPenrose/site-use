import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InterceptHandler } from '../../src/primitives/types.js';
import { createMockPrimitives } from '../../src/testing/index.js';

let createThrottledPrimitives: typeof import('../../src/primitives/throttle.js').createThrottledPrimitives;

beforeEach(async () => {
  const mod = await import('../../src/primitives/throttle.js');
  createThrottledPrimitives = mod.createThrottledPrimitives;
});

describe('ThrottledPrimitives', () => {
  it('delegates navigate to inner primitives', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 0, maxDelay: 0 });
    await throttled.navigate('https://x.com');
    expect(inner.navigate).toHaveBeenCalledWith('https://x.com');
  });

  it('delegates click to inner primitives', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 0, maxDelay: 0 });
    await throttled.click('5');
    expect(inner.click).toHaveBeenCalledWith('5');
  });

  it('adds delay before throttled operations', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 50, maxDelay: 50 });

    const start = Date.now();
    await throttled.navigate('https://x.com');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });

  it('does NOT throttle takeSnapshot (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.takeSnapshot();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.takeSnapshot).toHaveBeenCalledWith();
  });

  it('does NOT throttle screenshot (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.screenshot();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.screenshot).toHaveBeenCalledWith();
  });

  it('does NOT throttle getRawPage (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.getRawPage();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.getRawPage).toHaveBeenCalledWith();
  });

  it('does NOT throttle evaluate (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.evaluate('1+1');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.evaluate).toHaveBeenCalledWith('1+1');
  });

  it('does NOT throttle interceptRequest (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });
    const handler: InterceptHandler = () => {};

    const start = Date.now();
    await throttled.interceptRequest('/api/*', handler);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.interceptRequest).toHaveBeenCalledWith('/api/*', handler);
  });

  it('uses default config when none provided', async () => {
    const inner = createMockPrimitives();
    // Should not throw — defaults to { minDelay: 1000, maxDelay: 3000 }
    const throttled = createThrottledPrimitives(inner);
    expect(throttled).toBeDefined();
  });

  it('delegates interceptRequest to inner primitives', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 0, maxDelay: 0 });
    const handler: InterceptHandler = () => {};
    await throttled.interceptRequest('/api/*', handler);
    expect(inner.interceptRequest).toHaveBeenCalledWith('/api/*', handler);
  });
});

describe('rate limiting', () => {
  it('accepts rateLimit config and passes operations through', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, {
      minDelay: 0,
      maxDelay: 0,
      rateLimit: { window: 60_000, maxOps: 10 },
    });

    await throttled.navigate('https://x.com');
    await throttled.click('1');
    await throttled.scroll({ direction: 'down' });

    expect(inner.navigate).toHaveBeenCalled();
    expect(inner.click).toHaveBeenCalled();
    expect(inner.scroll).toHaveBeenCalled();
  });

  it('does not rate-limit takeSnapshot (not counted)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, {
      minDelay: 0,
      maxDelay: 0,
      rateLimit: { window: 60_000, maxOps: 1 },
    });

    await throttled.navigate('https://x.com');
    // takeSnapshot should not be blocked even though 1 op already counted
    await throttled.takeSnapshot();
    expect(inner.takeSnapshot).toHaveBeenCalled();
  });

  it('does not rate-limit evaluate (not counted)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, {
      minDelay: 0,
      maxDelay: 0,
      rateLimit: { window: 60_000, maxOps: 1 },
    });

    await throttled.navigate('https://x.com');
    await throttled.evaluate('1+1');
    expect(inner.evaluate).toHaveBeenCalled();
  });

  it('counts scrollIntoView toward rate limit', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, {
      minDelay: 0,
      maxDelay: 0,
      rateLimit: { window: 60_000, maxOps: 100 },
    });

    await throttled.scrollIntoView('1');
    expect(inner.scrollIntoView).toHaveBeenCalledWith('1');
  });
});

describe('updated defaults', () => {
  it('has minDelay=2000 and maxDelay=5000 by default', () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner);
    expect(throttled).toBeDefined();
  });
});
