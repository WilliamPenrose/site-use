import type { Browser, Page, KeyInput } from 'puppeteer-core';
import { safePages } from '../browser/browser.js';
import { ElementNotFound, NavigationFailed, CdpThrottled } from '../errors.js';
import { getClickEnhancementConfig } from '../config.js';
import { humanScroll, scrollElementIntoView } from './scroll-enhanced.js';
import {
  applyJitter,
  checkOcclusion,
  waitForElementStable,
  clickWithTrajectory,
  injectCoordFix,
} from './click-enhanced.js';
import type {
  Primitives,
  Snapshot,
  SnapshotNode,
  ScrollOptions,
  InterceptHandler,
} from './types.js';
import { RateLimitDetector } from './rate-limit-detect.js';

const DEFAULT_SITE = '_default';

/** Delay (ms) after recovery for the compositor to start processing input events. */
const COMPOSITOR_SETTLE_MS = 500;

/** Named keys that keyboard.press() understands (generates keydown/keypress/keyup sequence). */
const KNOWN_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Shift', 'Control', 'Alt', 'Meta',
]);

export interface PuppeteerBackendOptions {
  siteDomains?: Record<string, string[]>;
  rateLimitDetector?: RateLimitDetector;
  /** Pre-assigned page for single-site mode. When set, browser is not needed. */
  page?: Page;
}

export class PuppeteerBackend implements Primitives {
  private browser: Browser | null;
  private pages: Map<string, Page> = new Map();
  private currentSite: string = DEFAULT_SITE;
  private siteDomains: Record<string, string[]>;
  private rateLimitDetector: RateLimitDetector | null;
  private listenedPages: WeakSet<Page> = new WeakSet();
  private loggedPageHit: Set<string> = new Set();

  // Internal: uid -> backendDOMNodeId mapping from last takeSnapshot
  private uidToBackendNodeId: Map<string, number> = new Map();

  constructor(
    browserOrOptions: Browser | PuppeteerBackendOptions,
    siteDomains?: Record<string, string[]> | PuppeteerBackendOptions,
    rateLimitDetector?: RateLimitDetector,
  ) {
    if (browserOrOptions && typeof browserOrOptions === 'object' && 'newPage' in browserOrOptions) {
      // Old signature: (browser, siteDomains?, rateLimitDetector?)
      this.browser = browserOrOptions as Browser;
      this.siteDomains = (siteDomains as Record<string, string[]>) ?? {};
      this.rateLimitDetector = rateLimitDetector ?? null;
    } else {
      // New signature: (options with page)
      const opts = browserOrOptions as PuppeteerBackendOptions;
      this.browser = null;
      this.siteDomains = opts.siteDomains ?? {};
      this.rateLimitDetector = opts.rateLimitDetector ?? null;

      if (opts.page) {
        const siteName = Object.keys(this.siteDomains)[0];
        if (siteName) {
          this.pages.set(siteName, opts.page);
          this.currentSite = siteName;
        }
      }
    }
  }

  private installResponseListener(page: Page, site: string): void {
    if (!this.rateLimitDetector || this.listenedPages.has(page)) return;
    this.listenedPages.add(page);

    page.on('response', async (response) => {
      try {
        // Puppeteer already returns lowercase header keys
        const headers = response.headers() as Record<string, string>;

        let body = '';
        try {
          // Timeout guard: response.text() can hang on streaming responses
          body = await Promise.race([
            response.text(),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('body read timeout')), 1000),
            ),
          ]);
        } catch {
          // Body unavailable or timed out — ok for default 429 check (uses status + headers)
        }

        this.rateLimitDetector!.onResponse(
          { url: response.url(), status: response.status(), headers, body },
          site,
        );
      } catch {
        // Don't let listener errors break page operations
      }
    });
  }

  private checkRateLimit(step: string): void {
    this.rateLimitDetector?.checkAndThrow(step, this.currentSite);
  }

  /**
   * Execute an action with throttle recovery.
   * If the action returns 'throttled', escalate through recovery levels (1→2→3),
   * checking visibility before each retry to avoid false negatives.
   */
  private async withThrottleRecovery(
    page: Page,
    action: () => Promise<'ok' | 'throttled'>,
    step: string,
  ): Promise<void> {
    let result = await action();
    for (const level of [1, 2, 3] as const) {
      if (result !== 'throttled') break;
      await this.recoverFromThrottle(page, level);

      // Check both signals: windowState (OS-level) and visibilityState (compositor-level).
      // Either one reporting "not ready" is enough to skip retry and escalate.
      const windowState = await this.getWindowState(page);
      const visible = await this.isPageVisible(page);
      if (windowState === 'minimized' || !visible) {
        console.error(`[site-use] page not ready after level ${level} (window=${windowState}, visible=${visible}) — escalating`);
        continue;
      }

      console.error(`[site-use] page visible — waiting ${COMPOSITOR_SETTLE_MS}ms for compositor`);
      await new Promise((r) => setTimeout(r, COMPOSITOR_SETTLE_MS));
      result = await action();
    }
    if (result === 'throttled') {
      throw new CdpThrottled(
        `CDP input events are throttled — ${step} failed after recovery attempts`,
        { step },
      );
    }
  }

  /**
   * Check if the page is actually visible to the compositor.
   * Uses Runtime.evaluate (not Input domain) so it works even when input is throttled.
   */
  private async isPageVisible(page: Page): Promise<boolean> {
    let client;
    try {
      client = await page.createCDPSession();
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.visibilityState',
      });
      return (result as any).result?.value === 'visible';
    } catch {
      return false;
    } finally {
      try { await client?.detach(); } catch {}
    }
  }

  /**
   * Get the OS window state (normal, minimized, maximized, fullscreen).
   */
  private async getWindowState(page: Page): Promise<string> {
    let client;
    try {
      client = await page.createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget') as { windowId: number };
      const { bounds } = await client.send('Browser.getWindowBounds', { windowId }) as any;
      return bounds?.windowState ?? 'unknown';
    } catch {
      return 'unknown';
    } finally {
      try { await client?.detach(); } catch {}
    }
  }

  /**
   * Ensure Chrome window is not minimized before any CDP operation.
   * macOS minimization suspends the renderer — AX tree, Input events,
   * and compositor all stop working. bringToFront is the only way to
   * un-minimize on macOS.
   */
  private async ensureWindowVisible(page: Page): Promise<void> {
    const windowState = await this.getWindowState(page);
    console.error(`[site-use] ensureWindowVisible: windowState=${windowState}`);
    if (windowState === 'minimized') {
      console.error('[site-use] window is minimized — restoring with bringToFront');
      await page.bringToFront();
      // Wait for compositor to actually produce a frame (rAF fires only after
      // the renderer is unblocked). Timeout guards against frozen renderer.
      await Promise.race([
        page.evaluate(() => new Promise<void>(r => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        })),
        new Promise<void>(r => setTimeout(r, 5000)),
      ]);
    }
  }

  /**
   * Collect browser state for throttle diagnostics.
   */
  private async diagnoseBrowserState(page: Page): Promise<string> {
    let client;
    try {
      client = await page.createCDPSession();
      const [visibility, hasFocus, windowInfo] = await Promise.all([
        client.send('Runtime.evaluate', { expression: 'document.visibilityState' })
          .then((r: any) => r.result?.value ?? 'unknown')
          .catch(() => 'unknown'),
        client.send('Runtime.evaluate', { expression: 'document.hasFocus()' })
          .then((r: any) => r.result?.value ?? 'unknown')
          .catch(() => 'unknown'),
        client.send('Browser.getWindowForTarget')
          .then(async (r: any) => {
            const bounds = await client!.send('Browser.getWindowBounds', { windowId: r.windowId });
            return (bounds as any).bounds?.windowState ?? 'unknown';
          })
          .catch(() => 'unknown'),
      ]);
      return `visibility=${visibility}, hasFocus=${hasFocus}, window=${windowInfo}`;
    } catch {
      return 'diagnostics unavailable';
    } finally {
      try { await client?.detach(); } catch {}
    }
  }

  /**
   * Attempt to recover from CDP input throttling.
   * Level 1: Re-apply focus emulation (fixes lost visibility override).
   * Level 2: Activate tab within Chrome (bringToFront).
   * Level 3: Un-minimize the OS window (Browser.setWindowBounds).
   */
  private async recoverFromThrottle(page: Page, level: 1 | 2 | 3): Promise<void> {
    const stateBefore = await this.diagnoseBrowserState(page);
    console.error(`[site-use] CDP input throttled — ${stateBefore}`);
    if (level === 1) {
      console.error('[site-use] recovering (level 1: DOM.enable + Overlay.enable)');
      let client;
      try {
        client = await page.createCDPSession();
        await client.send('DOM.enable');
        await client.send('Overlay.enable');
      } catch {
        // Overlay.enable may fail on some Chrome versions — non-fatal
      } finally {
        try { await client?.detach(); } catch {}
      }
    }
    if (level === 2) {
      console.error('[site-use] recovering (level 2: bringToFront)');
      await page.bringToFront();
    }
    if (level === 3) {
      console.error('[site-use] recovering (level 3: un-minimize)');
      let client;
      try {
        client = await page.createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget') as { windowId: number };
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
      } finally {
        try { await client?.detach(); } catch {}
      }
    }
    const stateAfter = await this.diagnoseBrowserState(page);
    console.error(`[site-use] after recovery — ${stateAfter}`);
  }

  private async getPage(): Promise<Page> {
    const key = this.currentSite;

    // 1. Map cache hit — validate page is still alive
    const cached = this.pages.get(key);
    if (cached) {
      try {
        cached.url(); // throws if tab was closed
      } catch {
        this.pages.delete(key);
        // fall through to tab scan / new page
      }
      if (this.pages.has(key)) {
        if (!this.loggedPageHit.has(key)) {
          console.error(`[site-use] getPage: using tab for "${key}" — ${cached.url()}`);
          this.loggedPageHit.add(key);
        }
        this.installResponseListener(cached, key);
        return cached;
      }
    }

    // 2. Scan existing browser tabs for domain match
    const domains = this.siteDomains[key];
    if (domains && this.browser) {
      try {
        const existingPages = await safePages(this.browser);
        for (const p of existingPages) {
          try {
            const pageUrl = p.url();
            if (pageUrl === 'about:blank' || pageUrl.startsWith('data:')) continue;
            const hostname = new URL(pageUrl).hostname;
            if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
              await injectCoordFix(p);
              this.pages.set(key, p);
              this.currentSite = key;
              this.installResponseListener(p, key);
              return p;
            }
          } catch {
            // page.url() threw — crashed tab, skip
            continue;
          }
        }
      } catch {
        // safePages() failed — fall through to newPage
      }
    }

    // 3. No existing tab — create new
    if (!this.browser) {
      throw new Error('PuppeteerBackend: no browser and no pre-assigned page for site');
    }
    const page = await this.browser.newPage();
    await injectCoordFix(page);
    this.pages.set(key, page);
    this.currentSite = key;
    this.installResponseListener(page, key);
    return page;
  }

  /**
   * Get page for operations that depend on layout/rendering.
   * Ensures window is not minimized — macOS minimization suspends the renderer,
   * breaking Accessibility, Input, and screenshot operations.
   *
   * Use for: takeSnapshot, click, scroll, scrollIntoView, screenshot.
   * For layout-independent operations (evaluate, navigate, pressKey, type,
   * interceptRequest), use getPage() instead.
   */
  private async getVisiblePage(): Promise<Page> {
    const page = await this.getPage();
    await this.ensureWindowVisible(page);
    return page;
  }

  async navigate(url: string): Promise<void> {
    this.checkRateLimit('navigate');
    const page = await this.getPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    } catch (err) {
      throw new NavigationFailed(
        `Failed to navigate to ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { url, step: 'navigate', retryable: true },
      );
    }
  }

  async takeSnapshot(): Promise<Snapshot> {
    this.checkRateLimit('takeSnapshot');
    console.error('[site-use] takeSnapshot() called');
    const page = await this.getVisiblePage();
    const client = await page.createCDPSession();

    try {
      const { nodes } = await client.send('Accessibility.getFullAXTree');
      return this.buildSnapshot(nodes);
    } finally {
      await client.detach();
    }
  }

  private buildSnapshot(axNodes: any[]): Snapshot {
    const idToNode = new Map<string, SnapshotNode>();
    this.uidToBackendNodeId = new Map();

    // Build nodeId -> axNode lookup for parent-child resolution
    const axNodeById = new Map<string, any>();
    for (const node of axNodes) {
      axNodeById.set(node.nodeId, node);
    }

    let nextUid = 1;

    // Map from AX nodeId to assigned uid (for child reference resolution)
    const axIdToUid = new Map<string, string>();

    // First pass: assign uids to valid nodes
    for (const node of axNodes) {
      if (this.shouldSkipNode(node)) continue;

      const uid = String(nextUid++);
      axIdToUid.set(node.nodeId, uid);

      if (node.backendDOMNodeId != null) {
        this.uidToBackendNodeId.set(uid, node.backendDOMNodeId);
      }
    }

    // Second pass: build SnapshotNode objects with children
    for (const node of axNodes) {
      const uid = axIdToUid.get(node.nodeId);
      if (!uid) continue;

      const snapshotNode: SnapshotNode = {
        uid,
        role: node.role?.value ?? '',
        name: node.name?.value ?? '',
      };

      // Optional properties from AX properties array
      if (node.properties) {
        for (const prop of node.properties) {
          const val = prop.value?.value;
          switch (prop.name) {
            case 'focused':
              if (val) snapshotNode.focused = true;
              break;
            case 'disabled':
              if (val) snapshotNode.disabled = true;
              break;
            case 'expanded':
              if (val != null) snapshotNode.expanded = val;
              break;
            case 'selected':
              if (val) snapshotNode.selected = true;
              break;
            case 'level':
              if (val != null) snapshotNode.level = val;
              break;
          }
        }
      }

      // Value (for form elements)
      if (node.value?.value != null) {
        snapshotNode.value = String(node.value.value);
      }

      // Children (resolve AX childIds to assigned uids)
      if (node.childIds?.length) {
        const childUids: string[] = [];
        for (const childId of node.childIds) {
          const childUid = axIdToUid.get(childId);
          if (childUid) childUids.push(childUid);
        }
        if (childUids.length > 0) {
          snapshotNode.children = childUids;
        }
      }

      idToNode.set(uid, snapshotNode);
    }

    return { idToNode };
  }

  private shouldSkipNode(node: any): boolean {
    if (node.ignored) return true;
    const role = node.role?.value;
    if (role === 'none' || role === 'Ignored') return true;
    return false;
  }

  /**
   * Resolve a snapshot uid to page + backendDOMNodeId.
   * Shared validation for click/type/scrollIntoView.
   */
  private async resolveUid(uid: string, step: string): Promise<{ page: Page; backendNodeId: number }> {
    if (this.uidToBackendNodeId.size === 0) {
      throw new ElementNotFound(
        `No snapshot available. Call takeSnapshot() before ${step}().`,
        { step, retryable: false, hint: 'Take a snapshot first to populate the element map, then retry.' },
      );
    }

    const backendNodeId = this.uidToBackendNodeId.get(uid);
    if (backendNodeId == null) {
      throw new ElementNotFound(`Element with uid "${uid}" not found in snapshot`, { step });
    }

    const page = await this.getPage();
    return { page, backendNodeId };
  }

  async click(uid: string): Promise<void> {
    this.checkRateLimit('click');
    const { page, backendNodeId } = await this.resolveUid(uid, 'click');
    await this.ensureWindowVisible(page);
    const config = getClickEnhancementConfig();

    // Step 1: Wait for element position to stabilize (CSS animations)
    // These use DOM/AX APIs (not input events), so they work even when
    // Chrome is in the background.
    const { center, box: elementBox } = await waitForElementStable(page, backendNodeId);
    let centerX = center.x;
    let centerY = center.y;

    // Step 2: Check for occlusion
    if (config.occlusionCheck) {
      const result = await checkOcclusion(page, centerX, centerY, backendNodeId);
      if (result.occluded && result.fallback) {
        centerX = result.fallback.x;
        centerY = result.fallback.y;
      }
    }

    // Step 3: Compute click target, then click
    const clickTarget = config.jitter
      ? applyJitter(centerX, centerY, 3, elementBox)
      : { x: centerX, y: centerY };

    if (config.trajectory) {
      await this.withThrottleRecovery(
        page,
        () => clickWithTrajectory(page, clickTarget.x, clickTarget.y, { box: elementBox }),
        'click',
      );
    } else {
      await page.mouse.click(clickTarget.x, clickTarget.y);
    }

    // Wait for DOM stability
    await new Promise((r) => setTimeout(r, 100));
  }

  async type(uid: string, text: string, options?: { delay?: number }): Promise<void> {
    this.checkRateLimit('type');
    const { page, backendNodeId } = await this.resolveUid(uid, 'type');

    // Focus the element via CDP
    const client = await page.createCDPSession();
    try {
      await client.send('DOM.focus', { backendNodeId });
    } catch (err) {
      throw new ElementNotFound(
        `Failed to focus element with uid "${uid}": ${err instanceof Error ? err.message : String(err)}`,
        { step: 'type', retryable: true, hint: 'The DOM may have changed since takeSnapshot(). Try taking a new snapshot and retrying.' },
      );
    } finally {
      await client.detach();
    }

    // Type text via Puppeteer keyboard
    await page.keyboard.type(text, { delay: options?.delay ?? 0 });

    // Wait for DOM stability
    await new Promise((r) => setTimeout(r, 100));
  }

  async pressKey(key: string): Promise<void> {
    this.checkRateLimit('pressKey');
    const page = await this.getPage();
    // Keyboard events (Input.dispatchKeyEvent) are not subject to Chromium's
    // background tab throttling — no throttle recovery needed here.

    if (KNOWN_KEYS.has(key)) {
      await page.keyboard.press(key as KeyInput);
    } else {
      // Characters (ASCII, CJK, emoji, etc.) — use sendCharacter (CDP Input.insertText)
      await page.keyboard.sendCharacter(key);
    }
  }

  async scroll(options: ScrollOptions): Promise<void> {
    this.checkRateLimit('scroll');
    const page = await this.getVisiblePage();
    const amount = options.amount ?? 600;
    const direction = options.direction === 'up' ? -1 : 1;
    const totalDelta = amount * direction;

    await this.withThrottleRecovery(
      page,
      () => humanScroll(page, 0, totalDelta),
      'scroll',
    );
  }

  async scrollIntoView(uid: string): Promise<void> {
    this.checkRateLimit('scrollIntoView');
    const { page, backendNodeId } = await this.resolveUid(uid, 'scrollIntoView');
    await this.ensureWindowVisible(page);
    await scrollElementIntoView(page, backendNodeId);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.checkRateLimit('evaluate');
    const page = await this.getPage();
    return await page.evaluate(expression) as T;
  }

  async screenshot(): Promise<string> {
    const page = await this.getVisiblePage();
    const result = await page.screenshot({ encoding: 'base64', type: 'png' });
    // Puppeteer may return Buffer or string depending on version
    if (typeof result === 'string') return result;
    return (result as Buffer).toString('base64');
  }

  async interceptRequest(
    urlPattern: string | RegExp,
    handler: InterceptHandler,
  ): Promise<() => void> {
    const page = await this.getPage();

    const listener = async (response: any) => {
      const url: string = response.url();
      const matches =
        typeof urlPattern === 'string'
          ? url.includes(urlPattern)
          : urlPattern.test(url);

      if (!matches) return;

      try {
        const body = await response.text();
        handler({
          url,
          status: response.status(),
          body,
        });
      } catch {
        // Response body may be unavailable (e.g., already consumed or redirect)
      }
    };

    page.on('response', listener);

    return () => {
      page.off('response', listener);
    };
  }

  async getRawPage(): Promise<Page> {
    return this.getPage();
  }
}
