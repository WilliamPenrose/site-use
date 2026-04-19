import type { KeyInput, Page } from 'puppeteer-core';
import {
  applyJitter,
  checkOcclusion,
  clickWithTrajectory,
  injectCoordFix,
  waitForElementStable,
} from './click-enhanced.js';
import { getClickEnhancementConfig } from './click-config.js';
import { humanScroll, scrollElementIntoView } from './scroll-enhanced.js';
import { CdpThrottled, ElementNotFound, NavigationFailed } from './errors.js';
import type {
  InterceptControl,
  Primitives,
  ScrollOptions,
  Snapshot,
  SnapshotNode,
} from '../types.js';

const compositorSettleMs = 500;

const KNOWN_KEYS = new Set<KeyInput>([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Shift', 'Control', 'Alt', 'Meta',
]);

export class PuppeteerPageBackend implements Primitives {
  private readonly uidToBackendNodeId = new Map<string, number>();
  private readonly coordFixReady: Promise<void>;

  constructor(private readonly page: Page) {
    this.coordFixReady = injectCoordFix(page).catch(() => undefined);
  }

  private async withThrottleRecovery(
    action: () => Promise<'ok' | 'throttled'>,
    step: string,
  ): Promise<void> {
    let result = await action();
    for (const level of [1, 2, 3] as const) {
      if (result !== 'throttled') {
        break;
      }

      await this.recoverFromThrottle(level);
      const windowState = await this.getWindowState();
      const visible = await this.isPageVisible();

      if (windowState === 'minimized' || !visible) {
        console.error(
          `[site-use/core] page not ready after level ${level} (window=${windowState}, visible=${visible})`,
        );
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, compositorSettleMs));
      result = await action();
    }

    if (result === 'throttled') {
      throw new CdpThrottled(
        `CDP input events are throttled - ${step} failed after recovery attempts`,
        { step },
      );
    }
  }

  private async isPageVisible(): Promise<boolean> {
    let client;
    try {
      client = await this.page.createCDPSession();
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.visibilityState',
      }) as { result?: { value?: string } };
      return result.result?.value === 'visible';
    } catch {
      return false;
    } finally {
      try {
        await client?.detach();
      } catch {}
    }
  }

  private async getWindowState(): Promise<string> {
    let client;
    try {
      client = await this.page.createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget') as { windowId: number };
      const { bounds } = await client.send('Browser.getWindowBounds', { windowId }) as {
        bounds?: { windowState?: string };
      };
      return bounds?.windowState ?? 'unknown';
    } catch {
      return 'unknown';
    } finally {
      try {
        await client?.detach();
      } catch {}
    }
  }

  private async ensureWindowVisible(): Promise<void> {
    const windowState = await this.getWindowState();
    if (windowState === 'minimized') {
      await this.page.bringToFront();
      await Promise.race([
        this.page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }

  private async diagnoseBrowserState(): Promise<string> {
    let client;
    try {
      client = await this.page.createCDPSession();
      const [visibility, hasFocus, windowInfo] = await Promise.all([
        client.send('Runtime.evaluate', { expression: 'document.visibilityState' })
          .then((result: any) => result.result?.value ?? 'unknown')
          .catch(() => 'unknown'),
        client.send('Runtime.evaluate', { expression: 'document.hasFocus()' })
          .then((result: any) => result.result?.value ?? 'unknown')
          .catch(() => 'unknown'),
        client.send('Browser.getWindowForTarget')
          .then(async (result: any) => {
            const bounds = await client!.send('Browser.getWindowBounds', { windowId: result.windowId });
            return (bounds as any).bounds?.windowState ?? 'unknown';
          })
          .catch(() => 'unknown'),
      ]);
      return `visibility=${visibility}, hasFocus=${hasFocus}, window=${windowInfo}`;
    } catch {
      return 'diagnostics unavailable';
    } finally {
      try {
        await client?.detach();
      } catch {}
    }
  }

  private async recoverFromThrottle(level: 1 | 2 | 3): Promise<void> {
    const stateBefore = await this.diagnoseBrowserState();
    console.error(`[site-use/core] CDP input throttled - ${stateBefore}`);

    if (level === 1) {
      let client;
      try {
        client = await this.page.createCDPSession();
        await client.send('DOM.enable');
        await client.send('Overlay.enable');
      } catch {
        // Overlay.enable may fail on some Chrome versions.
      } finally {
        try {
          await client?.detach();
        } catch {}
      }
    }

    if (level === 2) {
      await this.page.bringToFront();
    }

    if (level === 3) {
      let client;
      try {
        client = await this.page.createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget') as { windowId: number };
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
      } finally {
        try {
          await client?.detach();
        } catch {}
      }
    }
  }

  async navigate(url: string): Promise<void> {
    await this.coordFixReady;
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    } catch (error) {
      throw new NavigationFailed(
        `Failed to navigate to ${url}: ${(error as Error).message}`,
        { url },
      );
    }
  }

  async takeSnapshot(): Promise<Snapshot> {
    await this.ensureWindowVisible();
    const client = await this.page.createCDPSession();

    try {
      const { nodes } = await client.send('Accessibility.getFullAXTree') as { nodes: any[] };
      return this.buildSnapshot(nodes);
    } finally {
      await client.detach();
    }
  }

  private buildSnapshot(axNodes: any[]): Snapshot {
    const idToNode = new Map<string, SnapshotNode>();
    this.uidToBackendNodeId.clear();
    const axIdToUid = new Map<string, string>();
    let nextUid = 1;

    for (const node of axNodes) {
      if (this.shouldSkipNode(node)) {
        continue;
      }

      const uid = String(nextUid++);
      axIdToUid.set(node.nodeId, uid);
      if (node.backendDOMNodeId != null) {
        this.uidToBackendNodeId.set(uid, node.backendDOMNodeId);
      }
    }

    for (const node of axNodes) {
      const uid = axIdToUid.get(node.nodeId);
      if (!uid) {
        continue;
      }

      const snapshotNode: SnapshotNode = {
        uid,
        role: node.role?.value ?? '',
        name: node.name?.value ?? '',
      };

      if (node.properties) {
        for (const prop of node.properties) {
          const value = prop.value?.value;
          switch (prop.name) {
            case 'focused':
              if (value) snapshotNode.focused = true;
              break;
            case 'disabled':
              if (value) snapshotNode.disabled = true;
              break;
            case 'expanded':
              if (value != null) snapshotNode.expanded = value;
              break;
            case 'selected':
              if (value) snapshotNode.selected = true;
              break;
            case 'level':
              if (value != null) snapshotNode.level = value;
              break;
          }
        }
      }

      if (node.value?.value != null) {
        snapshotNode.value = String(node.value.value);
      }

      if (node.childIds?.length) {
        const childUids: string[] = [];
        for (const childId of node.childIds) {
          const childUid = axIdToUid.get(childId);
          if (childUid) {
            childUids.push(childUid);
          }
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
    if (node.ignored) {
      return true;
    }
    const role = node.role?.value;
    return role === 'none' || role === 'Ignored';
  }

  private async resolveUid(
    uid: string,
    step: string,
  ): Promise<{ backendNodeId: number }> {
    if (this.uidToBackendNodeId.size === 0) {
      throw new ElementNotFound(
        `No snapshot available. Call takeSnapshot() before ${step}().`,
        { step, retryable: false, hint: 'Take a snapshot first, then retry.' },
      );
    }

    const backendNodeId = this.uidToBackendNodeId.get(uid);
    if (backendNodeId == null) {
      throw new ElementNotFound(`Element with uid "${uid}" not found in snapshot`, { step });
    }

    return { backendNodeId };
  }

  async click(uid: string): Promise<void> {
    const { backendNodeId } = await this.resolveUid(uid, 'click');
    await this.ensureWindowVisible();
    const config = getClickEnhancementConfig();
    const { center, box: elementBox } = await waitForElementStable(this.page, backendNodeId);
    let centerX = center.x;
    let centerY = center.y;

    if (config.occlusionCheck) {
      const result = await checkOcclusion(this.page, centerX, centerY, backendNodeId);
      if (result.occluded && result.fallback) {
        centerX = result.fallback.x;
        centerY = result.fallback.y;
      }
    }

    const clickTarget = config.jitter
      ? applyJitter(centerX, centerY, 3, elementBox)
      : { x: centerX, y: centerY };

    if (config.trajectory) {
      await this.withThrottleRecovery(
        () => clickWithTrajectory(this.page, clickTarget.x, clickTarget.y, { box: elementBox }),
        'click',
      );
    } else {
      await this.page.mouse.click(clickTarget.x, clickTarget.y);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async type(uid: string, text: string, options?: { delay?: number }): Promise<void> {
    const { backendNodeId } = await this.resolveUid(uid, 'type');
    const client = await this.page.createCDPSession();

    try {
      await client.send('DOM.focus', { backendNodeId });
    } catch (error) {
      throw new ElementNotFound(
        `Failed to focus element with uid "${uid}": ${(error as Error).message}`,
        {
          step: 'type',
          retryable: true,
          hint: 'The DOM may have changed since takeSnapshot(). Try a fresh snapshot.',
        },
      );
    } finally {
      await client.detach();
    }

    await this.page.keyboard.type(text, { delay: options?.delay ?? 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async pressKey(key: string): Promise<void> {
    if (KNOWN_KEYS.has(key as KeyInput)) {
      await this.page.keyboard.press(key as KeyInput);
    } else {
      await this.page.keyboard.sendCharacter(key);
    }
  }

  async scroll(options: ScrollOptions): Promise<void> {
    await this.ensureWindowVisible();
    const amount = options.amount ?? 600;
    const direction = options.direction === 'up' ? -1 : 1;
    const totalDelta = amount * direction;

    await this.withThrottleRecovery(
      () => humanScroll(this.page, 0, totalDelta),
      'scroll',
    );
  }

  async scrollIntoView(uid: string): Promise<void> {
    const { backendNodeId } = await this.resolveUid(uid, 'scrollIntoView');
    await this.ensureWindowVisible();
    await scrollElementIntoView(this.page, backendNodeId);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return await this.page.evaluate(expression) as T;
  }

  async screenshot(): Promise<string> {
    await this.ensureWindowVisible();
    const result = await this.page.screenshot({ encoding: 'base64', type: 'png' });
    return typeof result === 'string' ? result : (result as Buffer).toString('base64');
  }

  async interceptRequestWithControl(
    urlPattern: string | RegExp,
    handler: (response: { url: string; status: number; body: string }) => void,
  ): Promise<InterceptControl> {
    let validRequests = new Set<object>();
    const matches = (url: string) =>
      typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);

    const requestListener = (request: any) => {
      if (matches(request.url())) {
        validRequests.add(request);
      }
    };

    const responseListener = async (response: any) => {
      if (!matches(response.url())) {
        return;
      }

      try {
        const body = await response.text();
        const request = response.request();
        if (!validRequests.has(request)) {
          return;
        }
        validRequests.delete(request);
        handler({
          url: response.url(),
          status: response.status(),
          body,
        });
      } catch {
        validRequests.delete(response.request());
      }
    };

    this.page.on('request', requestListener);
    this.page.on('response', responseListener);

    return {
      cleanup: () => {
        this.page.off('request', requestListener);
        this.page.off('response', responseListener);
      },
      reset: () => {
        validRequests = new Set();
      },
      hasPending: () => validRequests.size > 0,
    };
  }
}
