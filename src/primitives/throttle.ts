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
    navigate: (url) => throttledAndCounted(() => inner.navigate(url)),
    click: (uid) => throttledAndCounted(() => inner.click(uid)),
    // Note: options.delay is per-keystroke delay inside keyboard.type — stacks with throttle delay above.
    type: (uid, text, options) => throttledAndCounted(() => inner.type(uid, text, options)),
    // Exempt — humanScroll internals already provide humanization (bell curve,
    // jitter, step delays). Throttle on top makes continuous browsing scroll
    // unnaturally slow. Callers add their own inter-scroll pauses when needed.
    scroll: (options) => inner.scroll(options),
    scrollIntoView: (uid) => inner.scrollIntoView(uid),

    // Throttled but NOT counted
    takeSnapshot: () => inner.takeSnapshot(),
    evaluate: <T = unknown>(expression: string) =>
      inner.evaluate<T>(expression),
    interceptRequest: (pattern, handler) =>
      inner.interceptRequest(pattern, handler),
    interceptRequestWithControl: (pattern, handler) => inner.interceptRequestWithControl(pattern, handler),

    // Exempt — lightweight keyboard events, no page navigation or network
    pressKey: (key) => inner.pressKey(key),

    // Fully exempt
    screenshot: () => inner.screenshot(),
    getRawPage: () => inner.getRawPage(),
  };
}
