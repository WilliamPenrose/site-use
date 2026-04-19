import type { Primitives, ThrottleConfig } from '../types.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

const DEFAULT_CONFIG: ThrottleConfig = {
  minDelay: 2000,
  maxDelay: 5000,
};

function randomDelay(config: ThrottleConfig): Promise<void> {
  const ms = config.minDelay + Math.random() * (config.maxDelay - config.minDelay);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createThrottledPrimitives(
  inner: Primitives,
  config?: Partial<ThrottleConfig>,
): Primitives {
  const cfg: ThrottleConfig = { ...DEFAULT_CONFIG, ...config };
  const rateLimiter = cfg.rateLimit
    ? new SlidingWindowRateLimiter(cfg.rateLimit)
    : null;

  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    await randomDelay(cfg);
    return fn();
  }

  async function throttledAndCounted<T>(fn: () => Promise<T>): Promise<T> {
    if (rateLimiter) {
      const wait = rateLimiter.getWaitTime();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      rateLimiter.record();
    }
    await randomDelay(cfg);
    return fn();
  }

  return {
    navigate: (url) => throttledAndCounted(() => inner.navigate(url)),
    click: (uid) => throttledAndCounted(() => inner.click(uid)),
    type: (uid, text, options) => throttledAndCounted(() => inner.type(uid, text, options)),
    scroll: (options) => inner.scroll(options),
    scrollIntoView: (uid) => inner.scrollIntoView(uid),
    takeSnapshot: () => inner.takeSnapshot(),
    evaluate: <T = unknown>(expression: string) => inner.evaluate<T>(expression),
    interceptRequestWithControl: (pattern, handler) =>
      inner.interceptRequestWithControl(pattern, handler),
    pressKey: (key) => inner.pressKey(key),
    screenshot: () => inner.screenshot(),
  };
}
