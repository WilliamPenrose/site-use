import type { Browser, Page } from 'puppeteer-core';

export interface RuntimeProxyConfig {
  server: string;
  username?: string;
  password?: string;
  /**
   * Extra hosts to reach directly, bypassing the proxy — a Chrome `--proxy-bypass-list` value
   * (`;`-separated, e.g. `100.64.0.0/10;*.internal`). Loopback (localhost/127.0.0.1/[::1]) is always
   * bypassed regardless, so local dev servers stay reachable through an active proxy.
   */
  bypass?: string;
}

export type RuntimeWebRTCPolicy =
  | 'disable_non_proxied_udp'
  | 'default_public_interface_only'
  | 'off';

export interface RuntimeConfig {
  /** Required. Where Chrome profile + chrome.json + locks live. */
  dataDir: string;
  /** Default: `${dataDir}/chrome-profile` */
  chromeProfileDir?: string;
  /** Default: `${dataDir}/chrome.json` */
  chromeJsonPath?: string;
  proxy?: RuntimeProxyConfig;
  /** Source label for the proxy, used in launch logs. Optional. */
  proxySource?: string;
  /** Default: 'disable_non_proxied_udp' */
  webrtcPolicy?: RuntimeWebRTCPolicy;
}

/** Internal — every field present after defaults are applied. */
export interface ResolvedRuntimeConfig {
  dataDir: string;
  chromeProfileDir: string;
  chromeJsonPath: string;
  proxy?: RuntimeProxyConfig;
  proxySource?: string;
  webrtcPolicy: RuntimeWebRTCPolicy;
}

export interface ChromeInfo {
  pid: number;
  wsEndpoint: string;
}

export interface CloseResult {
  found: boolean;
  pid?: number;
  recovered?: boolean;
}

export interface RuntimeRateLimitSignal {
  url: string;
  resetAt?: Date;
  reason: string;
}

export type RuntimeDetectFn<TSignal extends RuntimeRateLimitSignal = RuntimeRateLimitSignal> = (
  response: {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
  },
) => TSignal | null;

export interface RuntimeAuthGuardResult {
  loggedIn: boolean;
  diagnostics?: unknown;
}

export interface RuntimeCheckLoginResult {
  loggedIn: boolean;
}

export interface RuntimeSiteDefinition<
  TPrimitives = unknown,
  TSignal extends RuntimeRateLimitSignal = RuntimeRateLimitSignal,
> {
  name: string;
  domains: string[];
  auth?: {
    check: (primitives: TPrimitives) => Promise<RuntimeCheckLoginResult>;
    guard?: (primitives: TPrimitives) => Promise<RuntimeAuthGuardResult>;
    guardNavigate?: boolean;
  };
  detect?: RuntimeDetectFn<TSignal>;
}

export interface SiteSession<
  TPrimitives = unknown,
  TRateLimitDetector = unknown,
  TSignal extends RuntimeRateLimitSignal = RuntimeRateLimitSignal,
> {
  site: RuntimeSiteDefinition<TPrimitives, TSignal>;
  primitives: TPrimitives;
  page: Page;
  mutex: {
    run<T>(fn: () => Promise<T>): Promise<T>;
  };
  circuitBreaker: {
    readonly isTripped: boolean;
    readonly streak: number;
    recordSuccess(): void;
    recordError(): void;
    reset(): void;
  };
  rateLimitDetector: TRateLimitDetector;
  authState: {
    loggedIn: boolean | null;
    lastCheckedAt: number | null;
  };
  ownPage: boolean;
  close(): Promise<void>;
}

export interface Runtime<
  TPrimitives = unknown,
  TRateLimitDetector = unknown,
  TSignal extends RuntimeRateLimitSignal = RuntimeRateLimitSignal,
> {
  ensureBrowser(opts?: { autoLaunch?: boolean; extraArgs?: string[] }): Promise<Browser>;
  launchBrowser(extraArgs?: string[]): Promise<ChromeInfo>;
  readChromeJson(chromeJsonPath: string): ChromeInfo | null;
  writeChromeJson(chromeJsonPath: string, info: ChromeInfo): void;
  recoverOrphanChrome(
    chromeProfileDir: string,
    chromeJsonPath: string,
  ): Promise<ChromeInfo | null>;
  closeBrowser(): Promise<CloseResult>;
  isBrowserConnected(): boolean;
  safePages(browser: Browser): Promise<Page[]>;
  unfreezePages(pages: Page[]): Promise<void>;
  openSite(
    site: RuntimeSiteDefinition<TPrimitives, TSignal>,
  ): Promise<SiteSession<TPrimitives, TRateLimitDetector, TSignal>>;
  hasSite(siteName: string): boolean;
  clearSite(siteName: string): Promise<void>;
  clearAll(): Promise<void>;
  close(opts?: { closeBrowser?: boolean }): Promise<void>;
}
