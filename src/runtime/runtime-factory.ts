import { createRuntime } from '@site-use/runtime';
import {
  createAuthGuardedPrimitives,
  createThrottledPrimitives,
  injectCoordFix,
  PuppeteerBackend,
  RateLimitDetector,
} from '@site-use/runtime/internal/primitives';
import { getConfig, getClickEnhancementConfig } from '../config.js';
import {
  CdpThrottled,
  ElementNotFound,
  NavigationFailed,
  RateLimited,
  SessionExpired,
} from '../errors.js';
import { buildWelcomeHTML } from '../browser/welcome.js';
import type { Primitives } from '../primitives/types.js';

export function createSiteUseRuntime() {
  const cfg = getConfig();
  return createRuntime<Primitives, RateLimitDetector>({
    config: {
      dataDir: cfg.dataDir,
      chromeProfileDir: cfg.chromeProfileDir,
      chromeJsonPath: cfg.chromeJsonPath,
      proxy: cfg.proxy,
      proxySource: cfg.proxySource,
      webrtcPolicy: cfg.webrtcPolicy,
    },
    hooks: {
      injectCoordFix,
      buildWelcomeHTML,
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
