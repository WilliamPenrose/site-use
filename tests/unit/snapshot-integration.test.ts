import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  getClickEnhancementConfig: vi.fn(() => ({ trajectory: false, jitter: false, occlusionCheck: false })),
}));
vi.mock('../../src/primitives/scroll-enhanced.js', () => ({
  humanScroll: vi.fn(), scrollElementIntoView: vi.fn(),
}));
vi.mock('../../src/primitives/click-enhanced.js', () => ({
  applyJitter: vi.fn((x: number, y: number) => ({ x, y })),
  checkOcclusion: vi.fn().mockResolvedValue({ occluded: false }),
  waitForElementStable: vi.fn().mockResolvedValue({ center: { x: 0, y: 0 }, box: { x: 0, y: 0, width: 10, height: 10 } }),
  clickWithTrajectory: vi.fn(), injectCoordFix: vi.fn(),
}));

import { PuppeteerBackend } from '../../src/primitives/puppeteer-backend.js';

function createMockPageWithFrames(frameTree: any, axResults: Record<string, any[]>) {
  const session = {
    send: vi.fn().mockImplementation((method: string, params?: any) => {
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree });
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({ nodes: axResults[params?.frameId] ?? [] });
      }
      return Promise.resolve({});
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const page = {
    url: vi.fn().mockReturnValue('https://example.com'),
    createCDPSession: vi.fn().mockResolvedValue(session),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(), off: vi.fn(),
    mouse: { click: vi.fn(), wheel: vi.fn(), move: vi.fn() },
    keyboard: { type: vi.fn(), press: vi.fn(), sendCharacter: vi.fn() },
  };

  return { page, session };
}

describe('takeSnapshot pipeline integration', () => {
  it('single frame — behaves identically to original', async () => {
    const { page } = createMockPageWithFrames(
      { frame: { id: 'main', url: 'https://example.com', securityOrigin: 'https://example.com' } },
      {
        main: [
          { nodeId: 'a1', role: { value: 'button' }, name: { value: 'Follow' }, backendDOMNodeId: 101, ignored: false, properties: [] },
          { nodeId: 'a2', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 102, ignored: false, properties: [] },
        ],
      },
    );

    const backend = new PuppeteerBackend({ page: page as any, siteDomains: { test: ['example.com'] } });
    const snapshot = await backend.takeSnapshot();

    expect(snapshot.idToNode.size).toBe(2);
    expect(snapshot.idToNode.get('1')!.role).toBe('button');
    expect(snapshot.idToNode.get('1')!.name).toBe('Follow');
    expect(snapshot.idToNode.get('1')!.frameUrl).toBeUndefined();
    expect(snapshot.idToNode.get('2')!.role).toBe('link');
  });

  it('multi-frame — includes iframe nodes with frameUrl', async () => {
    const { page } = createMockPageWithFrames(
      {
        frame: { id: 'main', url: 'https://app.example.com', securityOrigin: 'https://app.example.com' },
        childFrames: [{
          frame: { id: 'iframe-1', url: 'https://app.example.com/form', securityOrigin: 'https://app.example.com' },
        }],
      },
      {
        main: [
          { nodeId: 'a1', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 100, ignored: false, properties: [] },
        ],
        'iframe-1': [
          { nodeId: 'b1', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 200, ignored: false, properties: [] },
          { nodeId: 'b2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 201, ignored: false, properties: [] },
        ],
      },
    );

    const backend = new PuppeteerBackend({ page: page as any, siteDomains: { test: ['example.com'] } });
    const snapshot = await backend.takeSnapshot();

    expect(snapshot.idToNode.size).toBe(3);

    // Main frame node — no frameUrl
    expect(snapshot.idToNode.get('1')!.name).toBe('Send');
    expect(snapshot.idToNode.get('1')!.frameUrl).toBeUndefined();

    // iframe nodes — have frameUrl
    expect(snapshot.idToNode.get('2')!.name).toBe('Email');
    expect(snapshot.idToNode.get('2')!.frameUrl).toBe('https://app.example.com/form');
    expect(snapshot.idToNode.get('3')!.name).toBe('Submit');
    expect(snapshot.idToNode.get('3')!.frameUrl).toBe('https://app.example.com/form');
  });

  it('cross-origin iframe is excluded', async () => {
    const { page } = createMockPageWithFrames(
      {
        frame: { id: 'main', url: 'https://app.example.com', securityOrigin: 'https://app.example.com' },
        childFrames: [{
          frame: { id: 'oopif', url: 'https://ads.other.com', securityOrigin: 'https://ads.other.com' },
        }],
      },
      {
        main: [
          { nodeId: 'a1', role: { value: 'button' }, name: { value: 'OK' }, backendDOMNodeId: 100, ignored: false, properties: [] },
        ],
        oopif: [
          { nodeId: 'c1', role: { value: 'link' }, name: { value: 'Ad' }, backendDOMNodeId: 300, ignored: false, properties: [] },
        ],
      },
    );

    const backend = new PuppeteerBackend({ page: page as any, siteDomains: { test: ['example.com'] } });
    const snapshot = await backend.takeSnapshot();

    expect(snapshot.idToNode.size).toBe(1);
    expect(snapshot.idToNode.get('1')!.name).toBe('OK');
  });
});
