import type { Page } from 'puppeteer-core';
import type { Primitives } from '../primitives/types.js';
import type { SitePlugin } from '../registry/types.js';
import { PuppeteerBackend } from '../primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../primitives/throttle.js';
import { createAuthGuardedPrimitives } from '../primitives/auth-guard.js';
import { RateLimitDetector } from '../primitives/rate-limit-detect.js';

export interface SiteStack {
  /** Auth-guarded outermost wrapper. */
  primitives: Primitives;
  /** Per-site rate limit detector (exposed for diagnostics). */
  rateLimitDetector: RateLimitDetector;
}

/**
 * Build a full primitives stack for a single site on a pre-created Page.
 * Browser lifecycle is managed by SiteRuntimeManager, not this function.
 *
 * Layers (inside → outside):
 *   PuppeteerBackend → RateLimitDetect → Throttle → AuthGuard
 */
export function buildSiteStack(
  page: Page,
  plugin: SitePlugin,
): SiteStack {
  // Build rate-limit detector for this single site
  const siteDetectors: Record<string, (response: {
    url: string; status: number; headers: Record<string, string>; body: string;
  }) => { url: string; resetAt?: Date; reason: string } | null> = {};
  if (plugin.detect) {
    siteDetectors[plugin.name] = plugin.detect;
  }
  const rateLimitDetector = new RateLimitDetector(siteDetectors);

  // Create backend scoped to this site's page and domains
  const backend = new PuppeteerBackend({
    siteDomains: { [plugin.name]: plugin.domains },
    rateLimitDetector,
    page,
  });

  // Throttle layer
  const throttled = createThrottledPrimitives(backend);

  // Auth guard layer — skip if plugin explicitly opts out
  const auth = plugin.auth;
  const authConfigs = auth && auth.guardNavigate !== false
    ? [{
        site: plugin.name,
        domains: plugin.domains,
        check: auth.guard
          ? auth.guard
          : async (inner: Primitives) => {
              const result = await auth.check(inner);
              return { loggedIn: result.loggedIn };
            },
      }]
    : [];

  const guarded = createAuthGuardedPrimitives(throttled, authConfigs);

  return { primitives: guarded, rateLimitDetector };
}
