import type { Primitives, ThrottleConfig } from './types.js';
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

  /** Throttle delay only (no rate-limit counting). */
  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    await randomDelay(cfg);
    return fn();
  }

  /** Throttle delay + rate-limit counting. */
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
    // Counted toward rate limit
    navigate: (url, site?) => throttledAndCounted(() => inner.navigate(url, site)),
    click: (uid, site?) => throttledAndCounted(() => inner.click(uid, site)),
    type: (uid, text, site?) => throttledAndCounted(() => inner.type(uid, text, site)),
    scroll: (options, site?) => throttledAndCounted(() => inner.scroll(options, site)),
    scrollIntoView: (uid, site?) => throttledAndCounted(() => inner.scrollIntoView(uid, site)),

    // Throttled but NOT counted
    takeSnapshot: (site?) => inner.takeSnapshot(site),
    evaluate: <T = unknown>(expression: string, site?: string) =>
      inner.evaluate<T>(expression, site),
    interceptRequest: (pattern, handler, site?) =>
      inner.interceptRequest(pattern, handler, site),

    // Fully exempt
    screenshot: (site?) => inner.screenshot(site),
    getRawPage: (site?) => inner.getRawPage(site),
  };
}
