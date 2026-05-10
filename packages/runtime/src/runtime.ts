import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import {
  closeBrowser as closeBrowserLifecycle,
  ensureBrowser as ensureBrowserLifecycle,
  isBrowserConnected as isBrowserConnectedLifecycle,
  launchAndDetach,
  readChromeJson,
  recoverOrphanChrome,
  safePages,
  unfreezePages,
  type BrowserLifecycleHooks,
  writeChromeJson,
} from './browser-lifecycle.js';
import { CircuitBreaker } from './internal/circuit-breaker.js';
import { Mutex } from './internal/mutex.js';
import type {
  ChromeInfo,
  CloseResult,
  ResolvedRuntimeConfig,
  Runtime,
  RuntimeAuthGuardResult,
  RuntimeConfig,
  RuntimeRateLimitSignal,
  RuntimeSiteDefinition,
  SiteSession,
} from './types.js';

function resolveConfig(config: RuntimeConfig): ResolvedRuntimeConfig {
  if (!config.dataDir) {
    throw new Error('createRuntime: config.dataDir is required');
  }
  return {
    dataDir: config.dataDir,
    chromeProfileDir:
      config.chromeProfileDir ?? path.join(config.dataDir, 'chrome-profile'),
    chromeJsonPath:
      config.chromeJsonPath ?? path.join(config.dataDir, 'chrome.json'),
    proxy: config.proxy,
    proxySource: config.proxySource,
    webrtcPolicy: config.webrtcPolicy ?? 'disable_non_proxied_udp',
  };
}

interface RuntimeAuthGuardConfig<TPrimitives> {
  site: string;
  domains: string[];
  check: (innerPrimitives: TPrimitives) => Promise<RuntimeAuthGuardResult>;
}

interface RuntimeHooks<
  TPrimitives,
  TRateLimitDetector,
  TSignal extends RuntimeRateLimitSignal,
> extends BrowserLifecycleHooks {
  buildSiteStack?: (
    page: Page,
    site: RuntimeSiteDefinition<TPrimitives, TSignal>,
  ) => {
    primitives: TPrimitives;
    rateLimitDetector: TRateLimitDetector;
  };
  createRateLimitDetector?: (
    siteDetectors?: Record<string, (response: {
      url: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    }) => TSignal | null>,
  ) => TRateLimitDetector;
  createSitePrimitives?: (options: {
    page: Page;
    siteDomains: Record<string, string[]>;
    rateLimitDetector: TRateLimitDetector;
  }) => TPrimitives;
  createThrottledPrimitives?: (inner: TPrimitives) => TPrimitives;
  createAuthGuardedPrimitives?: (
    inner: TPrimitives,
    configs: RuntimeAuthGuardConfig<TPrimitives>[],
  ) => TPrimitives;
}

function buildSiteStackFromHooks<
  TPrimitives,
  TRateLimitDetector,
  TSignal extends RuntimeRateLimitSignal,
>(
  page: Page,
  site: RuntimeSiteDefinition<TPrimitives, TSignal>,
  hooks: RuntimeHooks<TPrimitives, TRateLimitDetector, TSignal>,
): { primitives: TPrimitives; rateLimitDetector: TRateLimitDetector } {
  if (hooks.buildSiteStack) {
    return hooks.buildSiteStack(page, site);
  }

  if (
    !hooks.createRateLimitDetector ||
    !hooks.createSitePrimitives ||
    !hooks.createThrottledPrimitives ||
    !hooks.createAuthGuardedPrimitives
  ) {
    throw new Error(
      'createRuntime() requires either hooks.buildSiteStack() or the full stack assembly hooks.',
    );
  }

  const rateLimitDetector = hooks.createRateLimitDetector(
    site.detect ? { [site.name]: site.detect } : undefined,
  );

  const raw = hooks.createSitePrimitives({
    page,
    siteDomains: { [site.name]: site.domains },
    rateLimitDetector,
  });
  const throttled = hooks.createThrottledPrimitives(raw);

  const authConfigs = site.auth && site.auth.guardNavigate !== false
    ? [{
        site: site.name,
        domains: site.domains,
        check: site.auth.guard
          ? site.auth.guard
          : async (innerPrimitives: TPrimitives) => {
              const result = await site.auth!.check(innerPrimitives);
              return { loggedIn: result.loggedIn };
            },
      }]
    : [];

  const primitives = hooks.createAuthGuardedPrimitives(throttled, authConfigs);
  return { primitives, rateLimitDetector };
}

export function createRuntime<
  TPrimitives = unknown,
  TRateLimitDetector = unknown,
  TSignal extends RuntimeRateLimitSignal = RuntimeRateLimitSignal,
>(options: {
  config: RuntimeConfig;
  autoLaunch?: boolean;
  extraArgs?: string[];
  hooks?: RuntimeHooks<TPrimitives, TRateLimitDetector, TSignal>;
}): Runtime<TPrimitives, TRateLimitDetector, TSignal> {
  const config = resolveConfig(options.config);
  const hooks = options.hooks ?? {};
  const sessions = new Map<string, SiteSession<TPrimitives, TRateLimitDetector, TSignal>>();
  const pending = new Map<string, Promise<SiteSession<TPrimitives, TRateLimitDetector, TSignal>>>();
  let browser: Browser | null = null;

  async function ensureBrowserConnection(opts?: {
    autoLaunch?: boolean;
    extraArgs?: string[];
  }): Promise<Browser> {
    browser = await ensureBrowserLifecycle(
      {
        autoLaunch: opts?.autoLaunch ?? options.autoLaunch ?? true,
        extraArgs: opts?.extraArgs ?? options.extraArgs,
      },
      config,
      hooks,
    );
    return browser;
  }

  async function findExistingTab(
    site: RuntimeSiteDefinition<TPrimitives, TSignal>,
    activeBrowser: Browser,
  ): Promise<Page | null> {
    const claimedPages = new Set([...sessions.values()].map((session) => session.page));

    try {
      const pages = await safePages(activeBrowser, hooks);
      for (const page of pages) {
        if (claimedPages.has(page)) continue;
        try {
          const url = page.url();
          if (url === 'about:blank' || url.startsWith('data:')) continue;
          const hostname = new URL(url).hostname;
          if (site.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
            await hooks.injectCoordFix?.(page);
            return page;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // safePages failed
    }

    return null;
  }

  async function createSiteSession(
    site: RuntimeSiteDefinition<TPrimitives, TSignal>,
  ): Promise<SiteSession<TPrimitives, TRateLimitDetector, TSignal>> {
    const activeBrowser = await ensureBrowserConnection();
    const existingTab = await findExistingTab(site, activeBrowser);
    const page = existingTab ?? await activeBrowser.newPage();
    const { primitives, rateLimitDetector } = buildSiteStackFromHooks(page, site, hooks);

    const session: SiteSession<TPrimitives, TRateLimitDetector, TSignal> = {
      site,
      primitives,
      page,
      mutex: new Mutex(),
      circuitBreaker: new CircuitBreaker(),
      rateLimitDetector,
      authState: { loggedIn: null, lastCheckedAt: null },
      ownPage: !existingTab,
      close: async () => {
        if (session.ownPage) {
          await session.page.close().catch(() => {});
        }
        sessions.delete(site.name);
      },
    };

    sessions.set(site.name, session);
    return session;
  }

  return {
    ensureBrowser: ensureBrowserConnection,
    launchBrowser: async (extraArgs?: string[]): Promise<ChromeInfo> =>
      await launchAndDetach(extraArgs, config, hooks),
    readChromeJson: (chromeJsonPath: string) => readChromeJson(chromeJsonPath),
    writeChromeJson,
    recoverOrphanChrome: async (chromeProfileDir: string, chromeJsonPath: string) =>
      await recoverOrphanChrome(chromeProfileDir, chromeJsonPath),
    closeBrowser: async (): Promise<CloseResult> => {
      await Promise.all([...sessions.keys()].map(async (siteName) => {
        const session = sessions.get(siteName);
        if (session) await session.close();
      }));
      sessions.clear();
      browser = null;
      return await closeBrowserLifecycle(config, hooks);
    },
    isBrowserConnected: (): boolean => isBrowserConnectedLifecycle(),
    safePages: async (activeBrowser: Browser) => await safePages(activeBrowser, hooks),
    unfreezePages,
    openSite: async (
      site: RuntimeSiteDefinition<TPrimitives, TSignal>,
    ): Promise<SiteSession<TPrimitives, TRateLimitDetector, TSignal>> => {
      const existing = sessions.get(site.name);
      if (existing) return existing;

      const inflight = pending.get(site.name);
      if (inflight) return await inflight;

      const promise = createSiteSession(site);
      pending.set(site.name, promise);
      try {
        return await promise;
      } finally {
        pending.delete(site.name);
      }
    },
    hasSite: (siteName: string): boolean => sessions.has(siteName),
    clearSite: async (siteName: string): Promise<void> => {
      const session = sessions.get(siteName);
      if (session) {
        await session.close();
      }
    },
    clearAll: async (): Promise<void> => {
      for (const siteName of [...sessions.keys()]) {
        const session = sessions.get(siteName);
        if (session) await session.close();
      }
      browser = null;
    },
    close: async (opts?: { closeBrowser?: boolean }): Promise<void> => {
      for (const siteName of [...sessions.keys()]) {
        const session = sessions.get(siteName);
        if (session) await session.close();
      }
      sessions.clear();
      browser = null;

      if (opts?.closeBrowser) {
        await closeBrowserLifecycle(config, hooks);
      }
    },
  };
}
