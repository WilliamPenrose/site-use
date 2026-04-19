import type { Page } from 'puppeteer-core';
import type { Primitives, ThrottleConfig } from './types.js';
import { PuppeteerPageBackend } from './internal/puppeteer-page-backend.js';
import { createThrottledPrimitives } from './internal/throttle.js';

export interface CreateSecurePuppeteerPrimitivesOptions {
  page: Page;
  throttle?: Partial<ThrottleConfig>;
}

export function createSecurePuppeteerPrimitives(
  options: CreateSecurePuppeteerPrimitivesOptions,
): Primitives {
  const raw = new PuppeteerPageBackend(options.page);
  const safe = createThrottledPrimitives(raw, options.throttle);

  return {
    navigate: (url) => safe.navigate(url),
    takeSnapshot: () => safe.takeSnapshot(),
    click: (uid) => safe.click(uid),
    type: (uid, text, typeOptions) => safe.type(uid, text, typeOptions),
    pressKey: (key) => safe.pressKey(key),
    scroll: (scrollOptions) => safe.scroll(scrollOptions),
    scrollIntoView: (uid) => safe.scrollIntoView(uid),
    evaluate: <T = unknown>(expression: string) => safe.evaluate<T>(expression),
    screenshot: () => safe.screenshot(),
    interceptRequestWithControl: (pattern, handler) =>
      safe.interceptRequestWithControl(pattern, handler),
  };
}
