import type { Browser, Page } from 'puppeteer-core';
import { ElementNotFound, NavigationFailed } from '../errors.js';
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

export class PuppeteerBackend implements Primitives {
  private browser: Browser;
  private pages: Map<string, Page> = new Map();
  private currentSite: string = DEFAULT_SITE;
  private siteDomains: Record<string, string[]>;
  private rateLimitDetector: RateLimitDetector | null;
  private listenedPages: WeakSet<Page> = new WeakSet();

  // Internal: uid -> backendDOMNodeId mapping from last takeSnapshot
  private uidToBackendNodeId: Map<string, number> = new Map();

  constructor(
    browser: Browser,
    siteDomains: Record<string, string[]> = {},
    rateLimitDetector?: RateLimitDetector,
  ) {
    this.browser = browser;
    this.siteDomains = siteDomains;
    this.rateLimitDetector = rateLimitDetector ?? null;
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

  private checkRateLimit(step: string, site?: string): void {
    this.rateLimitDetector?.checkAndThrow(step, site ?? this.currentSite);
  }

  private async getPage(site?: string): Promise<Page> {
    const key = site ?? this.currentSite;

    // 1. Map cache hit
    const cached = this.pages.get(key);
    if (cached) {
      this.currentSite = key;
      this.installResponseListener(cached, key);
      return cached;
    }

    // 2. Scan existing browser tabs for domain match
    const domains = this.siteDomains[key];
    if (domains) {
      try {
        const existingPages = await this.browser.pages();
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
        // browser.pages() failed — fall through to newPage
      }
    }

    // 3. No existing tab — create new
    const page = await this.browser.newPage();
    await injectCoordFix(page);
    this.pages.set(key, page);
    this.currentSite = key;
    this.installResponseListener(page, key);
    return page;
  }

  async navigate(url: string, site?: string): Promise<void> {
    this.checkRateLimit('navigate', site);
    const page = await this.getPage(site);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    } catch (err) {
      throw new NavigationFailed(
        `Failed to navigate to ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { url, step: 'navigate', retryable: true },
      );
    }
  }

  async takeSnapshot(site?: string): Promise<Snapshot> {
    this.checkRateLimit('takeSnapshot', site);
    const page = await this.getPage(site);
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

  async click(uid: string, site?: string): Promise<void> {
    this.checkRateLimit('click', site);
    if (this.uidToBackendNodeId.size === 0) {
      throw new Error(
        'No snapshot available. Call takeSnapshot() before click().',
      );
    }

    const backendNodeId = this.uidToBackendNodeId.get(uid);
    if (backendNodeId == null) {
      throw new ElementNotFound(`Element with uid "${uid}" not found in snapshot`, {
        step: 'click',
      });
    }

    const page = await this.getPage(site);
    const config = getClickEnhancementConfig();

    // Step 1: Wait for element position to stabilize (CSS animations)
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

    // Step 3: Compute click target, then click (with or without trajectory)
    const clickTarget = config.jitter
      ? applyJitter(centerX, centerY, 3, elementBox)
      : { x: centerX, y: centerY };

    if (config.trajectory) {
      await clickWithTrajectory(page, clickTarget.x, clickTarget.y, {
        box: elementBox,
      });
    } else {
      await page.mouse.click(clickTarget.x, clickTarget.y);
    }

    // Wait for DOM stability
    await new Promise((r) => setTimeout(r, 100));
  }

  async type(_uid: string, _text: string, _site?: string): Promise<void> {
    throw new Error('type primitive is not implemented in M1 (planned for M2)');
  }

  async scroll(options: ScrollOptions, site?: string): Promise<void> {
    this.checkRateLimit('scroll', site);
    const page = await this.getPage(site);
    const amount = options.amount ?? 600;
    const direction = options.direction === 'up' ? -1 : 1;
    const totalDelta = amount * direction;

    await humanScroll(page, 0, totalDelta);
  }

  async scrollIntoView(uid: string, site?: string): Promise<void> {
    this.checkRateLimit('scrollIntoView', site);
    if (this.uidToBackendNodeId.size === 0) {
      throw new Error(
        'No snapshot available. Call takeSnapshot() before scrollIntoView().',
      );
    }

    const backendNodeId = this.uidToBackendNodeId.get(uid);
    if (backendNodeId == null) {
      throw new ElementNotFound(`Element with uid "${uid}" not found in snapshot`, {
        step: 'scrollIntoView',
      });
    }

    const page = await this.getPage(site);
    await scrollElementIntoView(page, backendNodeId);
  }

  async evaluate<T = unknown>(expression: string, site?: string): Promise<T> {
    this.checkRateLimit('evaluate', site);
    const page = await this.getPage(site);
    return await page.evaluate(expression) as T;
  }

  async screenshot(site?: string): Promise<string> {
    const page = await this.getPage(site);
    const result = await page.screenshot({ encoding: 'base64', type: 'png' });
    // Puppeteer may return Buffer or string depending on version
    if (typeof result === 'string') return result;
    return (result as Buffer).toString('base64');
  }

  async interceptRequest(
    urlPattern: string | RegExp,
    handler: InterceptHandler,
    site?: string,
  ): Promise<() => void> {
    const page = await this.getPage(site);

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

  async getRawPage(site?: string): Promise<Page> {
    return this.getPage(site);
  }
}
