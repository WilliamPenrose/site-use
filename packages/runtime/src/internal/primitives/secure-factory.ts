import type { Page } from 'puppeteer-core';
import type {
  ClickOptions,
  InterceptControl,
  ScrollOptions,
  Snapshot,
  ThrottleConfig,
} from './types.js';
import { PuppeteerBackend } from './puppeteer-backend.js';
import { createThrottledPrimitives } from './throttle.js';

export interface CreateSecurePuppeteerPrimitivesOptions {
  page: Page;
  throttle?: Partial<ThrottleConfig>;
}

export interface SecurePrimitives {
  navigate(url: string): Promise<void>;
  takeSnapshot(): Promise<Snapshot>;
  click(uid: string, options?: ClickOptions): Promise<void>;
  type(uid: string, text: string, options?: { delay?: number }): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(options: ScrollOptions): Promise<void>;
  scrollIntoView(uid: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(): Promise<string>;
  interceptRequestWithControl(
    urlPattern: string | RegExp,
    handler: (response: { url: string; status: number; body: string }) => void,
  ): Promise<InterceptControl>;
}

export function createSecurePuppeteerPrimitives(
  options: CreateSecurePuppeteerPrimitivesOptions,
): SecurePrimitives {
  const raw = new PuppeteerBackend({ page: options.page });
  const safe = createThrottledPrimitives(raw, options.throttle);

  return {
    navigate: (url) => safe.navigate(url),
    takeSnapshot: () => safe.takeSnapshot(),
    click: (uid, clickOptions) => safe.click(uid, clickOptions),
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
