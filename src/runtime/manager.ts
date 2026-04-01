import type { Browser, Page } from 'puppeteer-core';
import type { SitePlugin } from '../registry/types.js';
import type { SiteRuntime } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Mutex } from '../mutex.js';
import { buildSiteStack } from './build-site-stack.js';
import { ensureBrowser } from '../browser/browser.js';
import { injectCoordFix } from '../primitives/click-enhanced.js';

export class SiteRuntimeManager {
  private readonly runtimes = new Map<string, SiteRuntime>();
  private readonly pending = new Map<string, Promise<SiteRuntime>>();
  private readonly pluginsByName: Map<string, SitePlugin>;
  private browser: Browser | null = null;

  constructor(plugins: SitePlugin[]) {
    this.pluginsByName = new Map(plugins.map(p => [p.name, p]));
  }

  /** Check if a runtime exists for the given site. */
  has(siteName: string): boolean {
    return this.runtimes.has(siteName);
  }

  /** Get or lazily create a runtime for the given site. */
  async get(siteName: string): Promise<SiteRuntime> {
    const existing = this.runtimes.get(siteName);
    if (existing) return existing;

    // Concurrent creation protection: if another call is already creating
    // the runtime for this site, wait for that instead of creating a second one.
    const inflight = this.pending.get(siteName);
    if (inflight) return inflight;

    const promise = this.createRuntime(siteName);
    this.pending.set(siteName, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(siteName);
    }
  }

  private async createRuntime(siteName: string): Promise<SiteRuntime> {
    const plugin = this.pluginsByName.get(siteName);
    if (!plugin) {
      throw new Error(
        `Unknown site "${siteName}". Available sites: ${[...this.pluginsByName.keys()].join(', ')}`,
      );
    }

    // Ensure browser is running
    if (!this.browser || !this.browser.connected) {
      this.browser = await ensureBrowser({ autoLaunch: true });
    }

    // Reuse an existing tab that already has the site open (e.g. user's
    // manually-opened, logged-in tab).  Only fall back to newPage() when
    // no matching tab is found.
    const existingTab = await this.findExistingTab(plugin);
    const page = existingTab ?? await this.browser.newPage();
    const { primitives, rateLimitDetector } = buildSiteStack(page, plugin);

    const runtime: SiteRuntime = {
      plugin,
      primitives,
      page,
      mutex: new Mutex(),
      circuitBreaker: new CircuitBreaker(),
      rateLimitDetector,
      authState: { loggedIn: null, lastCheckedAt: null },
      ownPage: !existingTab,
    };

    this.runtimes.set(siteName, runtime);
    return runtime;
  }

  /**
   * Scan open browser tabs for one matching the plugin's domains.
   * Skips blank/data pages and tabs already claimed by another runtime.
   */
  private async findExistingTab(plugin: SitePlugin): Promise<Page | null> {
    if (!this.browser) return null;

    const domains = plugin.domains;
    const claimedPages = new Set(
      [...this.runtimes.values()].map(r => r.page),
    );

    try {
      const pages = await this.browser.pages();
      for (const p of pages) {
        if (claimedPages.has(p)) continue;
        try {
          const url = p.url();
          if (url === 'about:blank' || url.startsWith('data:')) continue;
          const hostname = new URL(url).hostname;
          if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
            await injectCoordFix(p);
            return p;
          }
        } catch {
          continue; // crashed tab
        }
      }
    } catch {
      // browser.pages() failed
    }
    return null;
  }

  /** Clear a specific site's runtime. */
  clear(siteName: string): void {
    const runtime = this.runtimes.get(siteName);
    if (runtime) {
      // Only close pages we created; leave user-opened tabs alone.
      if (runtime.ownPage) {
        runtime.page.close().catch(() => {});
      }
      this.runtimes.delete(siteName);
    }
  }

  /** Clear all runtimes (e.g. on browser disconnect). */
  clearAll(): void {
    for (const [name] of this.runtimes) {
      this.clear(name);
    }
    this.browser = null;
  }
}
