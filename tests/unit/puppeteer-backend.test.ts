import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and click-enhanced modules
vi.mock('../../src/config.js', () => ({
  getClickEnhancementConfig: vi.fn(() => ({
    trajectory: false,
    coordFix: false,
    jitter: false,
    occlusionCheck: false,
  })),
  getScrollEnhancementConfig: vi.fn(() => ({
    humanize: false,
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
    on: vi.fn(),
    off: vi.fn(),
    mouse: { click: vi.fn(), wheel: vi.fn(), move: vi.fn() },
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
  mockNewPage.mockClear();
  mockGoto.mockClear();
  mockEvaluate.mockClear();
  mockScreenshot.mockClear();
  const mod = await import('../../src/primitives/puppeteer-backend.js');
  PuppeteerBackend = mod.PuppeteerBackend;
});

describe('PuppeteerBackend', () => {
  describe('multi-page management', () => {
    it('creates a new page lazily on first access for a site', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      const page = await backend.getRawPage('twitter');
      expect(mockNewPage).toHaveBeenCalledOnce();
      expect(page).toBeDefined();
    });

    it('reuses existing page on subsequent access for same site', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.getRawPage('twitter');
      await backend.getRawPage('twitter');
      expect(mockNewPage).toHaveBeenCalledOnce();
    });

    it('creates separate pages for different sites', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.getRawPage('twitter');
      await backend.getRawPage('reddit');
      expect(mockNewPage).toHaveBeenCalledTimes(2);
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
      await backend.navigate('https://x.com/home', 'twitter');
      expect(mockGoto).toHaveBeenCalledWith('https://x.com/home', {
        waitUntil: 'load',
        timeout: 30_000,
      });
    });
  });

  describe('evaluate', () => {
    it('calls page.evaluate with expression string', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      mockEvaluate.mockResolvedValueOnce(42);
      const result = await backend.evaluate<number>('1 + 1', 'twitter');
      expect(mockEvaluate).toHaveBeenCalledWith('1 + 1');
      expect(result).toBe(42);
    });
  });

  describe('screenshot', () => {
    it('returns base64 PNG string', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      mockScreenshot.mockResolvedValueOnce(Buffer.from('fakepng'));
      const result = await backend.screenshot('twitter');
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
      const snapshot = await backend.takeSnapshot('twitter');

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
      const snapshot = await backend.takeSnapshot('twitter');

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
      const snapshot = await backend.takeSnapshot('twitter');

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
      const snapshot = await backend.takeSnapshot('twitter');

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
      const snapshot = await backend.takeSnapshot('twitter');

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
      await backend.takeSnapshot('twitter');
      await backend.click('1', 'twitter');

      // Center of (100,200)-(200,240) = (150, 220)
      expect(page.mouse.click).toHaveBeenCalledWith(150, 220);
    });

    it('throws ElementNotFound when uid is not in snapshot', async () => {
      setupClickMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot('twitter');
      await expect(backend.click('999', 'twitter')).rejects.toThrow(/not found/i);
    });

    it('throws when takeSnapshot has not been called', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.click('1', 'twitter')).rejects.toThrow(/snapshot/i);
    });
  });

  describe('scroll', () => {
    it('scrolls down using mouse wheel', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down' }, 'twitter');

      // mouse.wheel should have been called (possibly multiple times for progressive scroll)
      expect(page.mouse.wheel).toHaveBeenCalled();
    });

    it('scrolls up with negative delta', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'up' }, 'twitter');

      const calls = page.mouse.wheel.mock.calls;
      // At least one call should have negative deltaY
      const hasUpScroll = calls.some(
        (c: any[]) => c[0]?.deltaY < 0,
      );
      expect(hasUpScroll).toBe(true);
    });

    it('respects custom amount', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 300 }, 'twitter');

      // Total deltaY across all wheel calls should sum to approximately 300
      const totalDelta = page.mouse.wheel.mock.calls.reduce(
        (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0),
        0,
      );
      expect(totalDelta).toBeCloseTo(300, -1);
    });
  });

  describe('interceptRequest', () => {
    it('registers response listener on the page', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const handler = vi.fn();
      await backend.interceptRequest('/api/graphql', handler, 'twitter');

      expect(page.on).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('returns a cleanup function that removes the listener', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      const handler = vi.fn();
      const cleanup = await backend.interceptRequest('/api/graphql', handler, 'twitter');

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
      await backend.interceptRequest('/api/graphql', handler, 'twitter');

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
      await backend.interceptRequest('/api/graphql', handler, 'twitter');

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
      await backend.interceptRequest(/graphql.*HomeLatest/, handler, 'twitter');

      const mockResponse = {
        url: () => 'https://x.com/i/api/graphql/xyz/HomeLatestTimeline',
        status: () => 200,
        text: () => Promise.resolve('{"data":{}}'),
      };
      await registeredListener!(mockResponse);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('type (not implemented)', () => {
    it('throws NotImplemented error', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.type('5', 'hello', 'twitter')).rejects.toThrow(
        /not implemented/i,
      );
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
      await expect(backend.scrollIntoView('1', 'twitter')).rejects.toThrow(/snapshot/i);
    });

    it('throws ElementNotFound when uid is not in snapshot', async () => {
      setupScrollIntoViewMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot('twitter');
      await expect(backend.scrollIntoView('999', 'twitter')).rejects.toThrow(/not found/i);
    });

    it('delegates to scrollElementIntoView with correct backendNodeId', async () => {
      setupScrollIntoViewMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot('twitter');
      await backend.scrollIntoView('1', 'twitter');

      const { scrollElementIntoView } = await import('../../src/primitives/scroll-enhanced.js');
      expect(scrollElementIntoView).toHaveBeenCalledWith(page, 101);
    });
  });

  describe('scroll with humanize config', () => {
    it('uses mechanical scroll when humanize=false', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      // Default mock returns humanize: false
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 600 }, 'twitter');

      // Mechanical scroll: exactly 3 wheel calls
      expect(page.mouse.wheel).toHaveBeenCalledTimes(3);
    });

    it('delegates to humanScroll when humanize=true', async () => {
      const { getScrollEnhancementConfig } = await import('../../src/config.js');
      (getScrollEnhancementConfig as ReturnType<typeof vi.fn>).mockReturnValue({ humanize: true });

      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 600 }, 'twitter');

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      expect(humanScroll).toHaveBeenCalled();
    });
  });
});
