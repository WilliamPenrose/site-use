import type { Page } from 'puppeteer-core';
import type { RateLimitConfig } from './rate-limiter.js';
export type { RateLimitConfig };

// --- Snapshot types (aligned with devtools-mcp take_snapshot) ---

export interface SnapshotNode {
  uid: string;
  role: string;
  name: string;
  value?: string;
  children?: string[];
  focused?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
}

export interface Snapshot {
  /** uid -> node, O(1) lookup */
  idToNode: Map<string, SnapshotNode>;
}

// --- Scroll options ---

export interface ScrollOptions {
  direction: 'up' | 'down';
  /** Number of pixels per scroll step, default 600 */
  amount?: number;
}

// --- Request interception ---

export type InterceptHandler = (response: {
  url: string;
  status: number;
  body: string;
}) => void;

export interface InterceptControl {
  /** Remove the listener. */
  cleanup: () => void;
  /**
   * Replace the active handler. The new handler takes effect for all future
   * response callbacks, including in-flight ones that haven't resolved yet.
   * The handler reference is captured BEFORE `await response.text()`, so
   * swapping is safe against async race conditions.
   */
  swapHandler: (newHandler: InterceptHandler) => void;
}

// --- Throttle config ---

export interface ThrottleConfig {
  /** Minimum delay in ms before each operation, default 2000 */
  minDelay: number;
  /** Maximum delay in ms before each operation, default 5000 */
  maxDelay: number;
  /** Optional sliding window rate limit */
  rateLimit?: RateLimitConfig;
}

// --- Primitives interface ---

export interface Primitives {
  /** Navigate to URL and wait for load. Aligned with devtools-mcp navigate_page. */
  navigate(url: string): Promise<void>;

  /**
   * Get accessibility tree snapshot. Aligned with devtools-mcp take_snapshot.
   * Returns uid-indexed node map. uid is snapshot-scoped (refreshed each call).
   */
  takeSnapshot(): Promise<Snapshot>;

  /** Click element by snapshot uid. Aligned with devtools-mcp click. */
  click(uid: string): Promise<void>;

  /** Type text into element by snapshot uid. Aligned with devtools-mcp type. */
  type(uid: string, text: string, options?: { delay?: number }): Promise<void>;

  /**
   * Press a keyboard key. For named keys (Enter, ArrowDown, Tab, etc.) uses
   * keyboard.press(). For characters (including CJK, emoji) uses
   * keyboard.sendCharacter() which bypasses IME via CDP Input.insertText.
   */
  pressKey(key: string): Promise<void>;

  /** Scroll the page. Aligned with devtools-mcp scroll. */
  scroll(options: ScrollOptions): Promise<void>;

  /** Scroll element into view if not already visible. */
  scrollIntoView(uid: string): Promise<void>;

  /**
   * Execute JS expression in browser context. Aligned with devtools-mcp evaluate_script.
   * Pass string expressions, not function references (runs in browser, no Node.js closures).
   */
  evaluate<T = unknown>(expression: string): Promise<T>;

  /** Take screenshot, return base64 PNG. Aligned with devtools-mcp screenshot. */
  screenshot(): Promise<string>;

  /**
   * Intercept network responses matching URL pattern.
   * site-use extension (not in devtools-mcp). Used for GraphQL/API data extraction.
   * Handler is called for each matching response. Returns cleanup function.
   */
  interceptRequest(
    urlPattern: string | RegExp,
    handler: InterceptHandler,
  ): Promise<() => void>;

  /**
   * Like interceptRequest but returns an InterceptControl object that allows
   * swapping the handler without re-registering the listener.
   *
   * The handler reference is captured BEFORE the async `response.text()` call,
   * so in-flight responses use the handler that was active when the response
   * event fired, not when the body resolved. This prevents stale data from
   * leaking in after a handler swap.
   */
  interceptRequestWithControl(
    urlPattern: string | RegExp,
    handler: InterceptHandler,
  ): Promise<InterceptControl>;

  /**
   * Escape hatch: get raw Puppeteer Page for operations Primitives can't cover.
   * Exception, not the norm. Used for proxy auth (page.authenticate).
   */
  getRawPage(): Promise<Page>;
}
