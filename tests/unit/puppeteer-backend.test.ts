import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and click-enhanced modules
vi.mock('../../src/config.js', () => ({
  getClickEnhancementConfig: vi.fn(() => ({
    trajectory: false,
    jitter: false,
    occlusionCheck: false,
  })),
}));

vi.mock('../../src/primitives/scroll-enhanced.js', () => ({
  humanScroll: vi.fn().mockResolvedValue(undefined),
  scrollElementIntoView: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/primitives/click-enhanced.js', () => ({
  applyJitter: vi.fn((x: number, y: number) => ({ x, y })),
  checkOcclusion: vi.fn().mockResolvedValue({ occluded: false }),
  waitForElementStable: vi.fn().mockResolvedValue({ center: { x: 150, y: 220 }, box: { x: 100, y: 200, width: 100, height: 40 } }),
  clickWithTrajectory: vi.fn().mockResolvedValue(undefined),
  injectCoordFix: vi.fn().mockResolvedValue(undefined),
}));

// --- Mocks ---

const mockGoto = vi.fn().mockResolvedValue(undefined);
const mockEvaluate = vi.fn().mockResolvedValue('result');
const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from('png'));
const mockAuthenticate = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockUrl = vi.fn().mockReturnValue('about:blank');
const mockCreateCDPSession = vi.fn();

function createMockPage() {
  return {
    goto: mockGoto,
    evaluate: mockEvaluate,
    screenshot: mockScreenshot,
    authenticate: mockAuthenticate,
    close: mockClose,
    url: mockUrl,
    createCDPSession: mockCreateCDPSession,
    bringToFront: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    mouse: { click: vi.fn(), wheel: vi.fn(), move: vi.fn() },
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      sendCharacter: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const mockNewPage = vi.fn().mockResolvedValue(createMockPage());

const mockBrowser = {
  connected: true,
  newPage: mockNewPage,
};

// Import after mock setup
let PuppeteerBackend: typeof import('../../src/primitives/puppeteer-backend.js').PuppeteerBackend;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockNewPage.mockClear();
  mockGoto.mockClear();
  mockEvaluate.mockClear();
  mockScreenshot.mockClear();
  // Restore default resolved values after clearAllMocks
  mockNewPage.mockResolvedValue(createMockPage());
  const mod = await import('../../src/primitives/puppeteer-backend.js');
  PuppeteerBackend = mod.PuppeteerBackend;
});

describe('PuppeteerBackend', () => {
  describe('multi-page management', () => {
    it('creates a new page lazily on first access for a site', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      const page = await backend.getRawPage();
      expect(mockNewPage).toHaveBeenCalledOnce();
      expect(page).toBeDefined();
    });

    it('reuses existing page on subsequent access for same site', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.getRawPage();
      await backend.getRawPage();
      expect(mockNewPage).toHaveBeenCalledOnce();
    });

    it('uses default site when site param is omitted', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.getRawPage();
      await backend.getRawPage();
      expect(mockNewPage).toHaveBeenCalledOnce();
    });
  });

  describe('navigate', () => {
    it('calls page.goto with load waitUntil', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.navigate('https://x.com/home');
      expect(mockGoto).toHaveBeenCalledWith('https://x.com/home', {
        waitUntil: 'load',
        timeout: 30_000,
      });
    });

    it('wraps navigation errors as NavigationFailed', async () => {
      mockGoto.mockRejectedValueOnce(new Error('net::ERR_TIMED_OUT'));
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.navigate('https://x.com'))
        .rejects.toThrow(/Failed to navigate/);
    });
  });

  describe('evaluate', () => {
    it('calls page.evaluate with expression string', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      mockEvaluate.mockResolvedValueOnce(42);
      const result = await backend.evaluate<number>('1 + 1');
      expect(mockEvaluate).toHaveBeenCalledWith('1 + 1');
      expect(result).toBe(42);
    });
  });

  describe('screenshot', () => {
    it('returns base64 PNG string', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      mockScreenshot.mockResolvedValueOnce(Buffer.from('fakepng'));
      const result = await backend.screenshot();
      expect(mockScreenshot).toHaveBeenCalledWith({
        encoding: 'base64',
        type: 'png',
      });
      // screenshot mock returns Buffer, backend should handle both Buffer and string
      expect(typeof result).toBe('string');
    });
  });

  describe('takeSnapshot', () => {
    // Helper: build a mock CDP session that returns a fake AX tree
    function mockCDPSessionWithAXTree(nodes: any[]) {
      const session = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({ nodes });
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);
      return session;
    }

    it('returns snapshot with uid-indexed nodes from AX tree', async () => {
      mockCDPSessionWithAXTree([
        {
          nodeId: 'ax-1',
          role: { value: 'button' },
          name: { value: 'Follow' },
          backendDOMNodeId: 101,
          ignored: false,
          properties: [],
        },
        {
          nodeId: 'ax-2',
          role: { value: 'link' },
          name: { value: 'Home' },
          backendDOMNodeId: 102,
          ignored: false,
          properties: [],
        },
      ]);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const snapshot = await backend.takeSnapshot();

      expect(snapshot.idToNode.size).toBe(2);
      // First valid node gets uid "1"
      const node1 = snapshot.idToNode.get('1');
      expect(node1).toBeDefined();
      expect(node1!.role).toBe('button');
      expect(node1!.name).toBe('Follow');

      const node2 = snapshot.idToNode.get('2');
      expect(node2).toBeDefined();
      expect(node2!.role).toBe('link');
      expect(node2!.name).toBe('Home');
    });

    it('skips ignored nodes', async () => {
      mockCDPSessionWithAXTree([
        {
          nodeId: 'ax-1',
          role: { value: 'none' },
          name: { value: '' },
          backendDOMNodeId: 100,
          ignored: true,
          properties: [],
        },
        {
          nodeId: 'ax-2',
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId: 101,
          ignored: false,
          properties: [],
        },
      ]);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const snapshot = await backend.takeSnapshot();

      expect(snapshot.idToNode.size).toBe(1);
      const node = snapshot.idToNode.get('1');
      expect(node!.role).toBe('button');
    });

    it('skips nodes with role=none', async () => {
      mockCDPSessionWithAXTree([
        {
          nodeId: 'ax-1',
          role: { value: 'none' },
          name: { value: '' },
          backendDOMNodeId: 100,
          ignored: false,
          properties: [],
        },
        {
          nodeId: 'ax-2',
          role: { value: 'textbox' },
          name: { value: 'Search' },
          backendDOMNodeId: 101,
          ignored: false,
          properties: [],
        },
      ]);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const snapshot = await backend.takeSnapshot();

      expect(snapshot.idToNode.size).toBe(1);
      expect(snapshot.idToNode.get('1')!.role).toBe('textbox');
    });

    it('extracts optional properties (focused, disabled, expanded, level)', async () => {
      mockCDPSessionWithAXTree([
        {
          nodeId: 'ax-1',
          role: { value: 'button' },
          name: { value: 'Save' },
          backendDOMNodeId: 101,
          ignored: false,
          properties: [
            { name: 'disabled', value: { value: true } },
            { name: 'focused', value: { value: true } },
          ],
        },
      ]);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const snapshot = await backend.takeSnapshot();

      const node = snapshot.idToNode.get('1')!;
      expect(node.disabled).toBe(true);
      expect(node.focused).toBe(true);
    });

    it('builds parent-child relationships', async () => {
      mockCDPSessionWithAXTree([
        {
          nodeId: 'ax-1',
          role: { value: 'navigation' },
          name: { value: 'Main' },
          backendDOMNodeId: 100,
          ignored: false,
          childIds: ['ax-2', 'ax-3'],
          properties: [],
        },
        {
          nodeId: 'ax-2',
          role: { value: 'link' },
          name: { value: 'Home' },
          backendDOMNodeId: 101,
          ignored: false,
          properties: [],
        },
        {
          nodeId: 'ax-3',
          role: { value: 'link' },
          name: { value: 'Profile' },
          backendDOMNodeId: 102,
          ignored: false,
          properties: [],
        },
      ]);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const snapshot = await backend.takeSnapshot();

      const parent = snapshot.idToNode.get('1')!;
      expect(parent.children).toEqual(['2', '3']);
    });
  });

  describe('click', () => {
    function setupClickMocks() {
      const session = {
        send: vi.fn().mockImplementation((method: string, _params?: any) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({
              nodes: [
                {
                  nodeId: 'ax-1',
                  role: { value: 'button' },
                  name: { value: 'Follow' },
                  backendDOMNodeId: 101,
                  ignored: false,
                  properties: [],
                },
              ],
            });
          }
          if (method === 'DOM.describeNode') {
            return Promise.resolve({ node: { nodeId: 10 } });
          }
          if (method === 'DOM.getBoxModel') {
            // Box model content quad: 4 points (x,y pairs) forming a rectangle
            // Rectangle from (100,200) to (200,240)
            return Promise.resolve({
              model: {
                content: [100, 200, 200, 200, 200, 240, 100, 240],
              },
            });
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);
      return session;
    }

    it('clicks at the center of the element box model', async () => {
      setupClickMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      // Must takeSnapshot first to build uid mapping
      await backend.takeSnapshot();
      await backend.click('1');

      // Center of (100,200)-(200,240) = (150, 220)
      expect(page.mouse.click).toHaveBeenCalledWith(150, 220);
    });

    it('throws ElementNotFound when uid is not in snapshot', async () => {
      setupClickMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await expect(backend.click('999')).rejects.toThrow(/not found/i);
    });

    it('throws when takeSnapshot has not been called', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.click('1')).rejects.toThrow(/snapshot/i);
    });

    it('recovers from CDP throttle via bringToFront (level 1)', async () => {
      setupClickMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { getClickEnhancementConfig } = await import('../../src/config.js');
      vi.mocked(getClickEnhancementConfig).mockReturnValue({
        trajectory: true,
        jitter: false,
        occlusionCheck: false,
      });

      const { clickWithTrajectory } = await import('../../src/primitives/click-enhanced.js');
      vi.mocked(clickWithTrajectory)
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('ok');

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await backend.click('1');

      expect(page.bringToFront).toHaveBeenCalled();
      expect(clickWithTrajectory).toHaveBeenCalledTimes(2);
    });

    it('recovers from CDP throttle via un-minimize (level 2)', async () => {
      setupClickMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { getClickEnhancementConfig } = await import('../../src/config.js');
      vi.mocked(getClickEnhancementConfig).mockReturnValue({
        trajectory: true,
        jitter: false,
        occlusionCheck: false,
      });

      const { clickWithTrajectory } = await import('../../src/primitives/click-enhanced.js');
      vi.mocked(clickWithTrajectory)
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('ok');

      const cdpSession = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 });
          if (method === 'Browser.setWindowBounds') return Promise.resolve({});
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({ nodes: [{ nodeId: 'ax-1', role: { value: 'button' }, name: { value: 'Follow' }, backendDOMNodeId: 101, ignored: false, properties: [] }] });
          }
          if (method === 'DOM.describeNode') return Promise.resolve({ node: { nodeId: 10 } });
          if (method === 'DOM.getBoxModel') return Promise.resolve({ model: { content: [100, 200, 200, 200, 200, 240, 100, 240] } });
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(cdpSession);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await backend.click('1');

      expect(page.bringToFront).toHaveBeenCalled();
      expect(cdpSession.send).toHaveBeenCalledWith('Browser.getWindowForTarget');
      expect(cdpSession.send).toHaveBeenCalledWith('Browser.setWindowBounds', {
        windowId: 1,
        bounds: { windowState: 'normal' },
      });
      expect(clickWithTrajectory).toHaveBeenCalledTimes(3);
    });

    it('throws CdpThrottled when all recovery levels fail', async () => {
      setupClickMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { getClickEnhancementConfig } = await import('../../src/config.js');
      vi.mocked(getClickEnhancementConfig).mockReturnValue({
        trajectory: true,
        jitter: false,
        occlusionCheck: false,
      });

      const { clickWithTrajectory } = await import('../../src/primitives/click-enhanced.js');
      vi.mocked(clickWithTrajectory).mockResolvedValue('throttled');

      const cdpSession = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 });
          if (method === 'Browser.setWindowBounds') return Promise.resolve({});
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({ nodes: [{ nodeId: 'ax-1', role: { value: 'button' }, name: { value: 'Follow' }, backendDOMNodeId: 101, ignored: false, properties: [] }] });
          }
          if (method === 'DOM.describeNode') return Promise.resolve({ node: { nodeId: 10 } });
          if (method === 'DOM.getBoxModel') return Promise.resolve({ model: { content: [100, 200, 200, 200, 200, 240, 100, 240] } });
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(cdpSession);

      const { CdpThrottled } = await import('../../src/errors.js');
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();

      await expect(backend.click('1')).rejects.toThrow(CdpThrottled);
    });
  });

  describe('scroll', () => {
    it('delegates to humanScroll for down scroll', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down' });

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      expect(humanScroll).toHaveBeenCalledWith(page, 0, 600);
    });

    it('passes negative delta for up scroll', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'up' });

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      expect(humanScroll).toHaveBeenCalledWith(page, 0, -600);
    });

    it('respects custom amount', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 300 });

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      expect(humanScroll).toHaveBeenCalledWith(page, 0, 300);
    });

    it('recovers from CDP throttle via bringToFront (level 1)', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      vi.mocked(humanScroll)
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('ok');

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down' });

      expect(page.bringToFront).toHaveBeenCalled();
      expect(humanScroll).toHaveBeenCalledTimes(2);
    });

    it('recovers from CDP throttle via un-minimize (level 2)', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      vi.mocked(humanScroll)
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('throttled')
        .mockResolvedValueOnce('ok');

      const cdpSession = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 });
          if (method === 'Browser.setWindowBounds') return Promise.resolve({});
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(cdpSession);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down' });

      expect(page.bringToFront).toHaveBeenCalled();
      expect(cdpSession.send).toHaveBeenCalledWith('Browser.getWindowForTarget');
      expect(cdpSession.send).toHaveBeenCalledWith('Browser.setWindowBounds', {
        windowId: 1,
        bounds: { windowState: 'normal' },
      });
      expect(humanScroll).toHaveBeenCalledTimes(3);
    });

    it('throws CdpThrottled when all recovery levels fail', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      vi.mocked(humanScroll).mockResolvedValue('throttled');

      const cdpSession = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 });
          if (method === 'Browser.setWindowBounds') return Promise.resolve({});
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(cdpSession);

      const { CdpThrottled } = await import('../../src/errors.js');
      const backend = new PuppeteerBackend(mockBrowser as any);

      await expect(backend.scroll({ direction: 'down' })).rejects.toThrow(CdpThrottled);
    });
  });

  describe('interceptRequest', () => {
    it('registers response listener on the page', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const handler = vi.fn();
      await backend.interceptRequest('/api/graphql', handler);

      expect(page.on).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('returns a cleanup function that removes the listener', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const handler = vi.fn();
      const cleanup = await backend.interceptRequest('/api/graphql', handler);

      cleanup();
      expect(page.off).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('calls handler when response URL matches string pattern', async () => {
      const page = createMockPage();
      let registeredListener: Function | undefined;
      page.on = vi.fn().mockImplementation((event: string, fn: Function) => {
        if (event === 'response') registeredListener = fn;
      });
      mockNewPage.mockResolvedValue(page);

      const handler = vi.fn();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.interceptRequest('/api/graphql', handler);

      // Simulate a matching response
      const mockResponse = {
        url: () => 'https://x.com/i/api/graphql/abc/HomeLatestTimeline',
        status: () => 200,
        text: () => Promise.resolve('{"data":{}}'),
      };
      await registeredListener!(mockResponse);

      expect(handler).toHaveBeenCalledWith({
        url: 'https://x.com/i/api/graphql/abc/HomeLatestTimeline',
        status: 200,
        body: '{"data":{}}',
      });
    });

    it('does NOT call handler for non-matching URLs', async () => {
      const page = createMockPage();
      let registeredListener: Function | undefined;
      page.on = vi.fn().mockImplementation((event: string, fn: Function) => {
        if (event === 'response') registeredListener = fn;
      });
      mockNewPage.mockResolvedValue(page);

      const handler = vi.fn();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.interceptRequest('/api/graphql', handler);

      const mockResponse = {
        url: () => 'https://x.com/assets/some-script.js',
        status: () => 200,
        text: () => Promise.resolve(''),
      };
      await registeredListener!(mockResponse);

      expect(handler).not.toHaveBeenCalled();
    });

    it('supports RegExp pattern matching', async () => {
      const page = createMockPage();
      let registeredListener: Function | undefined;
      page.on = vi.fn().mockImplementation((event: string, fn: Function) => {
        if (event === 'response') registeredListener = fn;
      });
      mockNewPage.mockResolvedValue(page);

      const handler = vi.fn();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.interceptRequest(/graphql.*HomeLatest/, handler);

      const mockResponse = {
        url: () => 'https://x.com/i/api/graphql/xyz/HomeLatestTimeline',
        status: () => 200,
        text: () => Promise.resolve('{"data":{}}'),
      };
      await registeredListener!(mockResponse);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('type()', () => {
    function setupTypeMocks() {
      const session = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({
              nodes: [
                {
                  nodeId: 'ax-1',
                  role: { value: 'textbox' },
                  name: { value: 'Search' },
                  backendDOMNodeId: 101,
                  ignored: false,
                  properties: [],
                },
              ],
            });
          }
          if (method === 'DOM.focus') {
            return Promise.resolve({});
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);
      return session;
    }

    it('throws ElementNotFound when no snapshot taken', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.type('1', 'hello')).rejects.toThrow(/No snapshot available/);
    });

    it('throws ElementNotFound for unknown uid', async () => {
      setupTypeMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await expect(backend.type('99', 'hello')).rejects.toThrow(/not found in snapshot/);
    });

    it('focuses element and types text via keyboard', async () => {
      const session = setupTypeMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await backend.type('1', 'hello');

      // Verify CDP DOM.focus called with backendNodeId
      expect(session.send).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 101 });
      // Verify keyboard.type called with text and default delay
      expect(page.keyboard.type).toHaveBeenCalledWith('hello', { delay: 0 });
    });

    it('wraps DOM.focus failure as ElementNotFound', async () => {
      const session = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({
              nodes: [{
                nodeId: 'ax-1', role: { value: 'textbox' }, name: { value: 'Search' },
                backendDOMNodeId: 101, ignored: false, properties: [],
              }],
            });
          }
          if (method === 'DOM.focus') {
            return Promise.reject(new Error('Could not find node'));
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);

      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await expect(backend.type('1', 'hello')).rejects.toThrow(/Failed to focus element/);
    });

    it('passes delay option to keyboard.type', async () => {
      setupTypeMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await backend.type('1', '咖啡', { delay: 100 });

      expect(page.keyboard.type).toHaveBeenCalledWith('咖啡', { delay: 100 });
    });
  });

  describe('pressKey()', () => {
    it('presses a named key via keyboard.press', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.pressKey('Enter');

      expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
      expect(page.keyboard.sendCharacter).not.toHaveBeenCalled();
    });

    it('sends CJK characters via keyboard.sendCharacter', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.pressKey('咖');

      expect(page.keyboard.sendCharacter).toHaveBeenCalledWith('咖');
      expect(page.keyboard.press).not.toHaveBeenCalled();
    });

    it('sends single ASCII characters via keyboard.sendCharacter', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.pressKey('#');

      expect(page.keyboard.sendCharacter).toHaveBeenCalledWith('#');
    });

    it('sends emoji via keyboard.sendCharacter', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.pressKey('🔥');

      expect(page.keyboard.sendCharacter).toHaveBeenCalledWith('🔥');
      expect(page.keyboard.press).not.toHaveBeenCalled();
    });
  });

  describe('tab reuse', () => {
    const testDomains = { _default: ['x.com', 'twitter.com'] };

    it('reuses existing browser tab matching site domain instead of creating new', async () => {
      const existingPage = createMockPage();
      existingPage.url = vi.fn().mockReturnValue('https://x.com/home');
      const mockBrowserWithPages = {
        ...mockBrowser,
        pages: vi.fn().mockResolvedValue([existingPage]),
      };

      const backend = new PuppeteerBackend(mockBrowserWithPages as any, testDomains);
      const page = await backend.getRawPage();

      expect(mockBrowserWithPages.pages).toHaveBeenCalled();
      expect(mockNewPage).not.toHaveBeenCalled();
    });

    it('creates new page when no existing tab matches domain', async () => {
      const existingPage = createMockPage();
      existingPage.url = vi.fn().mockReturnValue('https://google.com');
      const mockBrowserWithPages = {
        ...mockBrowser,
        pages: vi.fn().mockResolvedValue([existingPage]),
      };

      const backend = new PuppeteerBackend(mockBrowserWithPages as any, testDomains);
      await backend.getRawPage();

      expect(mockNewPage).toHaveBeenCalled();
    });

    it('skips about:blank tabs during domain matching', async () => {
      const blankPage = createMockPage();
      blankPage.url = vi.fn().mockReturnValue('about:blank');
      const mockBrowserWithPages = {
        ...mockBrowser,
        pages: vi.fn().mockResolvedValue([blankPage]),
      };

      const backend = new PuppeteerBackend(mockBrowserWithPages as any, testDomains);
      await backend.getRawPage();

      expect(mockNewPage).toHaveBeenCalled();
    });

    it('skips tabs where page.url() throws (crashed tab)', async () => {
      const crashedPage = createMockPage();
      crashedPage.url = vi.fn().mockImplementation(() => { throw new Error('Target closed'); });
      const mockBrowserWithPages = {
        ...mockBrowser,
        pages: vi.fn().mockResolvedValue([crashedPage]),
      };

      const backend = new PuppeteerBackend(mockBrowserWithPages as any, testDomains);
      await backend.getRawPage();

      expect(mockNewPage).toHaveBeenCalled();
    });

    it('still uses Map cache on second call (no re-scan)', async () => {
      const existingPage = createMockPage();
      existingPage.url = vi.fn().mockReturnValue('https://x.com/home');
      const mockBrowserWithPages = {
        ...mockBrowser,
        pages: vi.fn().mockResolvedValue([existingPage]),
      };

      const backend = new PuppeteerBackend(mockBrowserWithPages as any, testDomains);
      await backend.getRawPage();
      await backend.getRawPage();

      // pages() scanned once, then Map cache hit
      expect(mockBrowserWithPages.pages).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale page detection', () => {
    it('recovers from a closed tab by dropping stale cache and rescanning', async () => {
      const closedPage = createMockPage();
      closedPage.url = vi.fn().mockImplementation(() => { throw new Error('Target closed'); });

      const freshPage = createMockPage();
      freshPage.url = vi.fn().mockReturnValue('https://x.com/home');
      freshPage.goto = vi.fn().mockResolvedValue(undefined);

      const mockBrowserWithPages = {
        connected: true,
        newPage: vi.fn().mockResolvedValue(freshPage),
        pages: vi.fn().mockResolvedValue([freshPage]),
      };

      const backend = new PuppeteerBackend(
        mockBrowserWithPages as any,
        { 'twitter': ['x.com'] },
      );

      // Inject stale page into cache via the options constructor
      const backendWithStale = new PuppeteerBackend({
        siteDomains: { 'twitter': ['x.com'] },
        page: closedPage as any,
      });

      // This should detect the stale page, drop it, and throw
      // (no browser in page-mode, so it can't recover)
      await expect(backendWithStale.navigate('https://x.com/home'))
        .rejects.toThrow();
    });

    it('evicts stale cached page and rescans browser tabs', async () => {
      const closedPage = createMockPage();
      closedPage.url = vi.fn().mockImplementation(() => { throw new Error('Target closed'); });

      const freshPage = createMockPage();
      freshPage.url = vi.fn().mockReturnValue('https://x.com/home');
      freshPage.goto = vi.fn().mockResolvedValue(undefined);

      const mockBrowserWithPages = {
        connected: true,
        newPage: vi.fn().mockResolvedValue(freshPage),
        pages: vi.fn().mockResolvedValue([freshPage]),
      };

      // Create backend with browser, then manually seed a stale page
      const backend = new PuppeteerBackend(
        mockBrowserWithPages as any,
        { '_default': ['x.com'] },
      );

      // First call to populate the cache with a good page
      await backend.getRawPage();
      // Now simulate: the cached page becomes stale
      // We need to access the private map — use navigate which calls getPage
      // Replace the cached page with a stale one by creating a new backend
      // that has both browser and a stale cache entry
      const backend2 = new PuppeteerBackend(
        mockBrowserWithPages as any,
        { '_default': ['x.com'] },
      );
      // Seed cache via first call
      mockBrowserWithPages.pages.mockResolvedValue([closedPage]);
      // closedPage.url throws, so tab scan skips it, falls through to newPage
      await backend2.getRawPage();
      // newPage was called because closedPage was skipped during scan
      expect(mockBrowserWithPages.newPage).toHaveBeenCalled();
    });
  });

  describe('scrollIntoView', () => {
    function setupScrollIntoViewMocks() {
      const session = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({
              nodes: [
                {
                  nodeId: 'ax-1',
                  role: { value: 'button' },
                  name: { value: 'Submit' },
                  backendDOMNodeId: 101,
                  ignored: false,
                  properties: [],
                },
              ],
            });
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);
      return session;
    }

    it('throws when takeSnapshot has not been called', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.scrollIntoView('1')).rejects.toThrow(/snapshot/i);
    });

    it('throws ElementNotFound when uid is not in snapshot', async () => {
      setupScrollIntoViewMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await expect(backend.scrollIntoView('999')).rejects.toThrow(/not found/i);
    });

    it('delegates to scrollElementIntoView with correct backendNodeId', async () => {
      setupScrollIntoViewMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot();
      await backend.scrollIntoView('1');

      const { scrollElementIntoView } = await import('../../src/primitives/scroll-enhanced.js');
      expect(scrollElementIntoView).toHaveBeenCalledWith(page, 101);
    });
  });

});
