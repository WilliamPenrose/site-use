import type { Browser, Page } from 'puppeteer-core';
import { ElementNotFound } from '../errors.js';
import { getClickEnhancementConfig } from '../config.js';
import {
  applyJitter,
  checkOcclusion,
  waitForElementStable,
  clickWithTrajectory,
} from './click-enhanced.js';
import type {
  Primitives,
  Snapshot,
  SnapshotNode,
  ScrollOptions,
  InterceptHandler,
} from './types.js';

const DEFAULT_SITE = '_default';

export class PuppeteerBackend implements Primitives {
  private browser: Browser;
  private pages: Map<string, Page> = new Map();
  private currentSite: string = DEFAULT_SITE;

  // Internal: uid -> backendDOMNodeId mapping from last takeSnapshot
  private uidToBackendNodeId: Map<string, number> = new Map();

  constructor(browser: Browser) {
    this.browser = browser;
  }

  private async getPage(site?: string): Promise<Page> {
    const key = site ?? this.currentSite;
    let page = this.pages.get(key);
    if (!page) {
      page = await this.browser.newPage();
      this.pages.set(key, page);
    }
    this.currentSite = key;
    return page;
  }

  async navigate(url: string, site?: string): Promise<void> {
    const page = await this.getPage(site);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }

  async takeSnapshot(site?: string): Promise<Snapshot> {
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
    let centerX: number;
    let centerY: number;

    if (config.stabilityWait) {
      const stable = await waitForElementStable(page, backendNodeId);
      centerX = stable.x;
      centerY = stable.y;
    } else {
      const client = await page.createCDPSession();
      try {
        const { model } = await client.send('DOM.getBoxModel', { backendNodeId });
        const quad = model.content;
        centerX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        centerY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      } finally {
        await client.detach();
      }
    }

    // Step 2: Check for occlusion
    if (config.occlusionCheck) {
      const result = await checkOcclusion(page, centerX, centerY, backendNodeId);
      if (result.occluded && result.fallback) {
        centerX = result.fallback.x;
        centerY = result.fallback.y;
      }
    }

    // Step 3: Click with trajectory + jitter, or direct click
    if (config.trajectory) {
      await clickWithTrajectory(page, centerX, centerY, {
        jitter: config.jitter,
      });
    } else {
      const target = config.jitter
        ? applyJitter(centerX, centerY, 3)
        : { x: centerX, y: centerY };
      await page.mouse.click(target.x, target.y);
    }

    // Wait for DOM stability
    await new Promise((r) => setTimeout(r, 100));
  }

  async type(_uid: string, _text: string, _site?: string): Promise<void> {
    throw new Error('type primitive is not implemented in M1 (planned for M2)');
  }

  async scroll(options: ScrollOptions, site?: string): Promise<void> {
    const page = await this.getPage(site);
    const amount = options.amount ?? 600;
    const direction = options.direction === 'up' ? -1 : 1;
    const totalDelta = amount * direction;

    // Progressive scroll: divide into steps
    const STEP_COUNT = 3;
    const stepDelta = totalDelta / STEP_COUNT;
    const STEP_PAUSE_MS = 80;

    for (let i = 0; i < STEP_COUNT; i++) {
      await page.mouse.wheel({ deltaY: stepDelta });
      if (i < STEP_COUNT - 1) {
        await new Promise((r) => setTimeout(r, STEP_PAUSE_MS));
      }
    }

    // Wait for lazy-loaded content after scroll completes
    await new Promise((r) => setTimeout(r, 500));
  }

  async evaluate<T = unknown>(expression: string, site?: string): Promise<T> {
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
