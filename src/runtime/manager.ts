import type { Browser } from 'puppeteer-core';
import type { SitePlugin } from '../registry/types.js';
import type { SiteRuntime } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Mutex } from '../mutex.js';
import { buildSiteStack } from './build-site-stack.js';
import { ensureBrowser } from '../browser/browser.js';

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

    // Build per-site stack
    const page = await this.browser.newPage();
    const { primitives, rateLimitDetector } = buildSiteStack(page, plugin);

    const runtime: SiteRuntime = {
      plugin,
      primitives,
      page,
      mutex: new Mutex(),
      circuitBreaker: new CircuitBreaker(),
      rateLimitDetector,
      authState: { loggedIn: null, lastCheckedAt: null },
    };

    this.runtimes.set(siteName, runtime);
    return runtime;
  }

  /** Clear a specific site's runtime. */
  clear(siteName: string): void {
    const runtime = this.runtimes.get(siteName);
    if (runtime) {
      runtime.page.close().catch(() => {});
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
