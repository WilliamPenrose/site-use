import type { Browser } from 'puppeteer-core';
import type { Primitives } from './types.js';
import {
  createAuthGuardedPrimitives,
  type AuthGuardCheckResult,
} from './auth-guard.js';
import { PuppeteerBackend } from './puppeteer-backend.js';
import { RateLimitDetector, type DetectFn } from './rate-limit-detect.js';
import { createThrottledPrimitives } from './throttle.js';

export interface SiteConfig {
  name: string;
  domains: string[];
  detect: DetectFn;
  authCheck: (primitives: Primitives) => Promise<boolean | AuthGuardCheckResult>;
}

export interface PrimitivesStack {
  guarded: Primitives;
  throttled: Primitives;
}

export function buildPrimitivesStack(
  browser: Browser,
  sites: SiteConfig[],
): PrimitivesStack {
  const siteDetectors: Record<string, DetectFn> = {};
  const siteDomains: Record<string, string[]> = {};

  for (const site of sites) {
    siteDetectors[site.name] = site.detect;
    siteDomains[site.name] = [...site.domains];
  }

  const detector = new RateLimitDetector(siteDetectors);
  const raw = new PuppeteerBackend(browser, siteDomains, detector);
  const throttled = createThrottledPrimitives(raw);
  const guarded = createAuthGuardedPrimitives(
    throttled,
    sites.map((site) => ({
      site: site.name,
      domains: [...site.domains],
      check: async (primitives) => {
        const result = await site.authCheck(primitives);
        return typeof result === 'boolean' ? { loggedIn: result } : result;
      },
    })),
  );

  return { guarded, throttled };
}
