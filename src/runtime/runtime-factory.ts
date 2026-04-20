import { createRuntime } from '@site-use/runtime';
import {
  createAuthGuardedPrimitives,
  createThrottledPrimitives,
  injectCoordFix,
  PuppeteerBackend,
  RateLimitDetector,
} from '@site-use/runtime/internal/primitives';
import { getConfig } from '../config.js';
import { getClickEnhancementConfig } from '../config.js';
import {
  BrowserDisconnected,
  BrowserNotRunning,
  CdpThrottled,
  ElementNotFound,
  NavigationFailed,
  RateLimited,
  SessionExpired,
} from '../errors.js';
import { isPidAlive } from '../lock.js';
import { buildWelcomeHTML } from '../browser/welcome.js';
import type { Primitives } from '../primitives/types.js';

export function createSiteUseRuntime() {
  return createRuntime<Primitives, RateLimitDetector>({
    hooks: {
      getConfig,
      injectCoordFix,
      isPidAlive,
      buildWelcomeHTML,
      BrowserDisconnected,
      BrowserNotRunning,
      createRateLimitDetector: (siteDetectors) =>
        new RateLimitDetector(siteDetectors, { RateLimited }),
      createSitePrimitives: ({ page, siteDomains, rateLimitDetector }) =>
        new PuppeteerBackend({
          page,
          rateLimitDetector,
          siteDomains,
        }, undefined, undefined, {
          ElementNotFound,
          NavigationFailed,
          CdpThrottled,
          getClickEnhancementConfig,
        }),
      createThrottledPrimitives,
      createAuthGuardedPrimitives: (inner, configs) =>
        createAuthGuardedPrimitives(inner, configs, { SessionExpired }),
    },
  });
}
