import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';
import { createRuntime } from '../../packages/runtime/src/index.js';

function fakePage(url: string): Page {
  return {
    close: vi.fn(async () => {}),
    url: () => url,
  } as unknown as Page;
}

function fakeBrowser(newPage = fakePage('about:blank')): Browser {
  return {
    connected: true,
    newPage: vi.fn(async () => newPage),
    targets: vi.fn(() => []),
  } as unknown as Browser;
}

describe('createRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults openSite() to autoLaunch=true', async () => {
    const ensureBrowser = vi.fn(async (_opts: { autoLaunch: boolean; extraArgs?: string[] }) =>
      fakeBrowser(),
    );
    const buildSiteStack = vi.fn((_page: Page) => ({
      primitives: { navigate: vi.fn(), screenshot: vi.fn() },
      rateLimitDetector: { clear: vi.fn() },
    }));

    const runtime = createRuntime({
      config: { dataDir: '/tmp/site-use-test' },
      hooks: {
        buildSiteStack,
        ensureBrowser,
      },
    });

    await runtime.openSite({ name: 'twitter', domains: ['x.com'] });

    expect(ensureBrowser).toHaveBeenCalledWith({ autoLaunch: true, extraArgs: undefined });
  });

  it('runtime.close() does not close Chrome by default', async () => {
    const browser = fakeBrowser();
    const browserClose = vi.fn(async () => {});
    const ensureBrowser = vi.fn(async (_opts: { autoLaunch: boolean; extraArgs?: string[] }) =>
      browser,
    );
    const buildSiteStack = vi.fn((_page: Page) => ({
      primitives: { navigate: vi.fn(), screenshot: vi.fn() },
      rateLimitDetector: { clear: vi.fn() },
    }));

    const runtime = createRuntime({
      config: { dataDir: '/tmp/site-use-test' },
      hooks: {
        buildSiteStack,
        closeBrowser: browserClose,
        ensureBrowser,
      },
    });

    await runtime.openSite({ name: 'twitter', domains: ['x.com'] });
    await runtime.close();

    expect(browserClose).not.toHaveBeenCalled();
  });

  it('reuses an existing matching tab before falling back to newPage()', async () => {
    const existing = fakePage('https://x.com/home');
    const browser = fakeBrowser();
    const ensureBrowser = vi.fn(async () => browser);
    const buildSiteStack = vi.fn((page: Page) => ({
      primitives: { navigate: vi.fn(), screenshot: vi.fn() },
      rateLimitDetector: { clear: vi.fn() },
    }));

    const runtime = createRuntime({
      config: { dataDir: '/tmp/site-use-test' },
      hooks: {
        buildSiteStack,
        ensureBrowser,
        safePages: vi.fn(async () => [existing]),
      },
    });

    const session = await runtime.openSite({ name: 'twitter', domains: ['x.com'] });

    expect(session.page).toBe(existing);
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it('closes only runtime-owned pages on clearSite()', async () => {
    const created = fakePage('about:blank');
    const browser = fakeBrowser(created);
    const ensureBrowser = vi.fn(async () => browser);
    const buildSiteStack = vi.fn((page: Page) => ({
      primitives: { navigate: vi.fn(), screenshot: vi.fn() },
      rateLimitDetector: { clear: vi.fn() },
    }));

    const runtime = createRuntime({
      config: { dataDir: '/tmp/site-use-test' },
      hooks: {
        buildSiteStack,
        ensureBrowser,
        safePages: vi.fn(async () => []),
      },
    });

    await runtime.openSite({ name: 'twitter', domains: ['x.com'] });
    await runtime.clearSite('twitter');

    expect(created.close).toHaveBeenCalled();
  });
});
