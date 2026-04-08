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
  /** Remove both request and response listeners. */
  cleanup: () => void;
  /**
   * Invalidate all in-flight and pending requests.
   * Future requests are tracked in a fresh Set.
   * Responses from requests initiated before reset() are silently discarded,
   * even if the response event fires or body resolves after reset().
   */
  reset: () => void;
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
   *
   * Use this for straight-line flows: register → navigate → collect → cleanup.
   * If the workflow needs to invalidate in-flight requests mid-lifecycle
   * (e.g. navigate loads wrong data, then interaction loads correct data),
   * use interceptRequestWithControl instead.
   */
  interceptRequest(
    urlPattern: string | RegExp,
    handler: InterceptHandler,
  ): Promise<() => void>;

  /**
   * Like interceptRequest but returns an InterceptControl with reset().
   * Tracks requests via a Set — reset() replaces it with a fresh empty Set,
   * invalidating all in-flight and pending requests. Response validity is
   * checked AFTER await response.text(), covering both in-flight callbacks
   * and late-arriving response events.
   *
   * Use this when the workflow switches data sources mid-lifecycle (e.g.
   * getFeed: navigate(home) triggers R1, then tab click triggers R2 —
   * reset() discards R1 responses so only R2 data enters the collector).
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
