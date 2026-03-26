import type { Primitives } from '../primitives/types.js';
import type { SitePlugin } from '../registry/types.js';
import type { Mutex } from '../mutex.js';
import type { Page } from 'puppeteer-core';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RateLimitDetector } from '../primitives/rate-limit-detect.js';

/** Per-site auth state — tracks last known login status. */
export interface AuthState {
  /** Whether the user was logged in at last check. null = never checked. */
  loggedIn: boolean | null;
  /** Timestamp of last auth check (ms since epoch). */
  lastCheckedAt: number | null;
}

export interface SiteRuntime {
  /** The plugin declaration this runtime was created from. */
  plugin: SitePlugin;
  /** Per-site primitives stack (throttle + auth guard + rate-limit detect). */
  primitives: Primitives;
  /** Dedicated Chrome tab for this site. */
  page: Page;
  /** Per-site operation lock — serializes operations within this site. */
  mutex: Mutex;
  /** Per-site circuit breaker — trips after consecutive errors on this site. */
  circuitBreaker: CircuitBreaker;
  /** Per-site rate limit detector — accessible for diagnostics/stats. */
  rateLimitDetector: RateLimitDetector;
  /** Per-site auth state — cached login status. */
  authState: AuthState;
  /** True if the page was created by us (newPage); false if reused from user. */
  ownPage: boolean;
}
