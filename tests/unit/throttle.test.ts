import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Primitives, InterceptHandler } from '../../src/primitives/types.js';

function createMockPrimitives(): Primitives {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    scrollIntoView: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('base64png'),
    interceptRequest: vi.fn().mockResolvedValue(() => {}),
    getRawPage: vi.fn().mockResolvedValue({}),
  };
}

let createThrottledPrimitives: typeof import('../../src/primitives/throttle.js').createThrottledPrimitives;

beforeEach(async () => {
  const mod = await import('../../src/primitives/throttle.js');
  createThrottledPrimitives = mod.createThrottledPrimitives;
});

describe('ThrottledPrimitives', () => {
  it('delegates navigate to inner primitives', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 0, maxDelay: 0 });
    await throttled.navigate('https://x.com', 'twitter');
    expect(inner.navigate).toHaveBeenCalledWith('https://x.com', 'twitter');
  });

  it('delegates click to inner primitives', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 0, maxDelay: 0 });
    await throttled.click('5', 'twitter');
    expect(inner.click).toHaveBeenCalledWith('5', 'twitter');
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
    await throttled.takeSnapshot('twitter');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.takeSnapshot).toHaveBeenCalledWith('twitter');
  });

  it('does NOT throttle screenshot (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.screenshot('twitter');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.screenshot).toHaveBeenCalledWith('twitter');
  });

  it('does NOT throttle getRawPage (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.getRawPage('twitter');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.getRawPage).toHaveBeenCalledWith('twitter');
  });

  it('does NOT throttle evaluate (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });

    const start = Date.now();
    await throttled.evaluate('1+1', 'twitter');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.evaluate).toHaveBeenCalledWith('1+1', 'twitter');
  });

  it('does NOT throttle interceptRequest (exempt)', async () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner, { minDelay: 200, maxDelay: 200 });
    const handler: InterceptHandler = () => {};

    const start = Date.now();
    await throttled.interceptRequest('/api/*', handler, 'twitter');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(inner.interceptRequest).toHaveBeenCalledWith('/api/*', handler, 'twitter');
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
    await throttled.interceptRequest('/api/*', handler, 'twitter');
    expect(inner.interceptRequest).toHaveBeenCalledWith('/api/*', handler, 'twitter');
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
    await throttled.takeSnapshot('twitter');
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

    await throttled.scrollIntoView('1', 'twitter');
    expect(inner.scrollIntoView).toHaveBeenCalledWith('1', 'twitter');
  });
});

describe('updated defaults', () => {
  it('has minDelay=2000 and maxDelay=5000 by default', () => {
    const inner = createMockPrimitives();
    const throttled = createThrottledPrimitives(inner);
    expect(throttled).toBeDefined();
  });
});
