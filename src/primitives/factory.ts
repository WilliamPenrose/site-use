import type { Browser } from 'puppeteer-core';
import type { Primitives } from './types.js';
import type { DetectFn } from './rate-limit-detect.js';
import { PuppeteerBackend } from './puppeteer-backend.js';
import { RateLimitDetector } from './rate-limit-detect.js';
import { createThrottledPrimitives } from './throttle.js';
import { createAuthGuardedPrimitives } from './auth-guard.js';

/**
 * Site-specific configuration — everything the factory needs to wire up
 * a site without importing any site module directly.
 */
export interface SiteConfig {
  name: string;
  domains: string[];
  /** Site-specific rate-limit detection (null = use default 429 detector). */
  detect: DetectFn;
  /** Auth check function — return true if logged in. Receives inner (throttled) primitives. */
  authCheck: (primitives: Primitives) => Promise<boolean>;
}

export interface PrimitivesStack {
  /** Auth-guarded primitives — the outermost wrapper, for most callers. */
  guarded: Primitives;
  /** Throttled primitives (no auth guard) — for checkLogin which must not trigger auth guard recursion. */
  throttled: Primitives;
}

/**
 * Build the full primitives stack: PuppeteerBackend → throttle → authGuard.
 * Site-agnostic — all site-specific behavior is injected via SiteConfig[].
 */
export function buildPrimitivesStack(
  browser: Browser,
  sites: SiteConfig[],
): PrimitivesStack {
  // Build site detectors map: { siteName: detectFn }
  const siteDetectors: Record<string, DetectFn> = {};
  const siteDomains: Record<string, string[]> = {};
  for (const site of sites) {
    siteDetectors[site.name] = site.detect;
    siteDomains[site.name] = [...site.domains];
  }

  const detector = new RateLimitDetector(siteDetectors);
  const raw = new PuppeteerBackend(browser, siteDomains, detector);
  const throttled = createThrottledPrimitives(raw);

  const authConfigs = sites.map((site) => ({
    site: site.name,
    domains: [...site.domains],
    check: site.authCheck,
  }));
  const guarded = createAuthGuardedPrimitives(throttled, authConfigs);

  return { guarded, throttled };
}
