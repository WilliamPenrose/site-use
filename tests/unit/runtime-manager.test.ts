import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteRuntimeManager } from '../../src/runtime/manager.js';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(name: string): SitePlugin {
  return { apiVersion: 1, name, domains: [`${name}.com`] };
}

function fakePage(url: string) {
  return { url: () => url, isClosed: () => false, close: vi.fn(async () => {}) };
}

// Default mock: browser with no existing tabs (pages() returns only about:blank)
let mockPages: ReturnType<typeof fakePage>[] = [];
const mockNewPage = vi.fn(async () => fakePage('about:blank'));

vi.mock('../../src/runtime/build-site-stack.js', () => ({
  buildSiteStack: vi.fn((_page: unknown, _plugin: SitePlugin) => ({
    primitives: { navigate: vi.fn(), takeSnapshot: vi.fn() } as never,
    rateLimitDetector: { signals: new Map(), checkAndThrow: vi.fn(), clear: vi.fn() } as never,
  })),
}));

vi.mock('../../src/primitives/click-enhanced.js', () => ({
  injectCoordFix: vi.fn(async () => {}),
}));

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(async () => ({
    connected: true,
    newPage: mockNewPage,
    pages: vi.fn(async () => mockPages),
    disconnect: vi.fn(),
  })),
}));

describe('SiteRuntimeManager', () => {
  let manager: SiteRuntimeManager;
  const plugins = [fakePlugin('twitter'), fakePlugin('reddit')];

  beforeEach(() => {
    manager = new SiteRuntimeManager(plugins);
  });

  it('creates runtime lazily on first get()', async () => {
    expect(manager.has('twitter')).toBe(false);
    const runtime = await manager.get('twitter');
    expect(runtime).toBeDefined();
    expect(runtime.plugin.name).toBe('twitter');
    expect(manager.has('twitter')).toBe(true);
  });

  it('returns cached runtime on subsequent get()', async () => {
    const first = await manager.get('twitter');
    const second = await manager.get('twitter');
    expect(first).toBe(second);
  });

  it('creates separate runtimes for different sites', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter).not.toBe(reddit);
    expect(twitter.plugin.name).toBe('twitter');
    expect(reddit.plugin.name).toBe('reddit');
  });

  it('throws for unknown site name', async () => {
    await expect(manager.get('nonexistent')).rejects.toThrow(/nonexistent/);
  });

  it('clear() removes a specific site runtime', async () => {
    await manager.get('twitter');
    expect(manager.has('twitter')).toBe(true);
    manager.clear('twitter');
    expect(manager.has('twitter')).toBe(false);
  });

  it('clearAll() removes all runtimes', async () => {
    await manager.get('twitter');
    await manager.get('reddit');
    manager.clearAll();
    expect(manager.has('twitter')).toBe(false);
    expect(manager.has('reddit')).toBe(false);
  });

  it('recreates runtime after clear()', async () => {
    const first = await manager.get('twitter');
    manager.clear('twitter');
    const second = await manager.get('twitter');
    expect(second).not.toBe(first);
  });

  it('each runtime has its own mutex', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.mutex).not.toBe(reddit.mutex);
  });

  it('each runtime has its own circuit breaker', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.circuitBreaker).not.toBe(reddit.circuitBreaker);
  });

  it('concurrent get() for same site returns same runtime (no duplicate creation)', async () => {
    const [a, b] = await Promise.all([
      manager.get('twitter'),
      manager.get('twitter'),
    ]);
    expect(a).toBe(b);
  });

  describe('tab reuse', () => {
    it('reuses existing browser tab matching site domain instead of newPage()', async () => {
      const existingTwitterTab = fakePage('https://twitter.com/home');
      mockPages = [existingTwitterTab];
      mockNewPage.mockClear();

      const runtime = await manager.get('twitter');
      expect(runtime.page).toBe(existingTwitterTab);
      expect(mockNewPage).not.toHaveBeenCalled();
    });

    it('falls back to newPage() when no matching tab exists', async () => {
      mockPages = [fakePage('https://reddit.com')];
      mockNewPage.mockClear();

      const runtime = await manager.get('twitter');
      expect(mockNewPage).toHaveBeenCalled();
      expect(runtime.page).not.toBe(mockPages[0]);
    });

    it('does not close reused tab on clear()', async () => {
      const existingTab = fakePage('https://twitter.com/home');
      mockPages = [existingTab];

      await manager.get('twitter');
      manager.clear('twitter');
      expect(existingTab.close).not.toHaveBeenCalled();
    });

    it('closes newPage() tab on clear()', async () => {
      mockPages = [];
      const createdPage = fakePage('about:blank');
      mockNewPage.mockResolvedValueOnce(createdPage);

      await manager.get('twitter');
      manager.clear('twitter');
      expect(createdPage.close).toHaveBeenCalled();
    });

    it('skips tabs already claimed by another site', async () => {
      const twitterTab = fakePage('https://twitter.com/home');
      mockPages = [twitterTab];

      // twitter claims the tab first
      await manager.get('twitter');
      mockNewPage.mockClear();

      // reddit should NOT get the twitter tab, should call newPage()
      await manager.get('reddit');
      expect(mockNewPage).toHaveBeenCalled();
    });
  });
});
