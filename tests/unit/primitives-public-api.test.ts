import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';
import { createSecurePuppeteerPrimitives } from '../../src/primitives/factory.js';

function createMockPage(): Page {
  return {
    goto: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue('ok'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    on: vi.fn(),
    off: vi.fn(),
    url: vi.fn().mockReturnValue('https://x.com/home'),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    mouse: {
      click: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
    },
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      sendCharacter: vi.fn().mockResolvedValue(undefined),
    },
    createCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ nodes: [] }),
      detach: vi.fn().mockResolvedValue(undefined),
    }),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe('root primitives public API', () => {
  it('returns only the secure public primitives surface', () => {
    const primitives = createSecurePuppeteerPrimitives({
      page: createMockPage(),
      throttle: { minDelay: 0, maxDelay: 0 },
    });

    expect(typeof primitives.navigate).toBe('function');
    expect(typeof primitives.takeSnapshot).toBe('function');
    expect(typeof primitives.click).toBe('function');
    expect(typeof primitives.type).toBe('function');
    expect(typeof primitives.pressKey).toBe('function');
    expect(typeof primitives.scroll).toBe('function');
    expect(typeof primitives.scrollIntoView).toBe('function');
    expect(typeof primitives.evaluate).toBe('function');
    expect(typeof primitives.screenshot).toBe('function');
    expect(typeof primitives.interceptRequestWithControl).toBe('function');

    expect('getRawPage' in (primitives as Record<string, unknown>)).toBe(false);
    expect('interceptRequest' in (primitives as Record<string, unknown>)).toBe(false);
  });

  it('delegates basic page operations through the secure factory', async () => {
    const page = createMockPage();
    const primitives = createSecurePuppeteerPrimitives({
      page,
      throttle: { minDelay: 0, maxDelay: 0 },
    });

    await primitives.navigate('https://x.com/home');
    await primitives.evaluate('document.title');
    await primitives.screenshot();

    expect(page.goto).toHaveBeenCalledWith('https://x.com/home', {
      waitUntil: 'load',
      timeout: 30_000,
    });
    expect(page.evaluate).toHaveBeenCalledWith('document.title');
    expect(page.screenshot).toHaveBeenCalledWith({
      encoding: 'base64',
      type: 'png',
    });
  });

  it('builds snapshot nodes from the AX tree through the page-scoped backend', async () => {
    const send = vi.fn().mockImplementation((method: string) => {
      if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 });
      if (method === 'Browser.getWindowBounds') {
        return Promise.resolve({ bounds: { windowState: 'normal' } });
      }
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({
          nodes: [{
            nodeId: 'ax-1',
            role: { value: 'button' },
            name: { value: 'Follow' },
            backendDOMNodeId: 101,
            ignored: false,
            properties: [],
          }],
        });
      }
      return Promise.resolve({});
    });

    const page = createMockPage();
    page.createCDPSession = vi.fn().mockResolvedValue({
      send,
      detach: vi.fn().mockResolvedValue(undefined),
    });

    const primitives = createSecurePuppeteerPrimitives({
      page,
      throttle: { minDelay: 0, maxDelay: 0 },
    });

    const snapshot = await primitives.takeSnapshot();

    expect(snapshot.idToNode.get('1')).toMatchObject({
      uid: '1',
      role: 'button',
      name: 'Follow',
    });
  });

  it('tracks pending intercepted requests and discards reset responses', async () => {
    let requestListener: ((request: any) => void) | undefined;
    let responseListener: ((response: any) => Promise<void>) | undefined;

    const page = createMockPage();
    page.on = vi.fn().mockImplementation((event: string, listener: any) => {
      if (event === 'request') requestListener = listener;
      if (event === 'response') responseListener = listener;
    });

    const handler = vi.fn();
    const primitives = createSecurePuppeteerPrimitives({
      page,
      throttle: { minDelay: 0, maxDelay: 0 },
    });

    const control = await primitives.interceptRequestWithControl('/graphql', handler);
    const request = {
      url: () => 'https://x.com/i/api/graphql/HomeLatestTimeline',
    };

    requestListener!(request);
    expect(control.hasPending()).toBe(true);

    control.reset();

    await responseListener!({
      url: () => 'https://x.com/i/api/graphql/HomeLatestTimeline',
      status: () => 200,
      text: () => Promise.resolve('{"data":{}}'),
      request: () => request,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(control.hasPending()).toBe(false);

    control.cleanup();
    expect(page.off).toHaveBeenCalledWith('request', expect.any(Function));
    expect(page.off).toHaveBeenCalledWith('response', expect.any(Function));
  });
});
