import type {
  Primitives,
  ThrottleConfig,
} from './types.js';

const DEFAULT_CONFIG: ThrottleConfig = {
  minDelay: 1000,
  maxDelay: 3000,
};

function randomDelay(config: ThrottleConfig): Promise<void> {
  const ms =
    config.minDelay +
    Math.random() * (config.maxDelay - config.minDelay);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createThrottledPrimitives(
  inner: Primitives,
  config?: Partial<ThrottleConfig>,
): Primitives {
  const cfg: ThrottleConfig = { ...DEFAULT_CONFIG, ...config };

  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    await randomDelay(cfg);
    return fn();
  }

  return {
    navigate: (url, site?) => throttled(() => inner.navigate(url, site)),
    takeSnapshot: (site?) => throttled(() => inner.takeSnapshot(site)),
    click: (uid, site?) => throttled(() => inner.click(uid, site)),
    type: (uid, text, site?) => throttled(() => inner.type(uid, text, site)),
    scroll: (options, site?) => throttled(() => inner.scroll(options, site)),
    scrollIntoView: (uid, site?) => throttled(() => inner.scrollIntoView(uid, site)),
    evaluate: <T = unknown>(expression: string, site?: string) =>
      throttled(() => inner.evaluate<T>(expression, site)),
    interceptRequest: (pattern, handler, site?) =>
      throttled(() => inner.interceptRequest(pattern, handler, site)),

    // Exempt: no throttle
    screenshot: (site?) => inner.screenshot(site),
    getRawPage: (site?) => inner.getRawPage(site),
  };
}
