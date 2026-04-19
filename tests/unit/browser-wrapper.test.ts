import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

const runtimeApi = {
  readChromeJson: vi.fn(),
  writeChromeJson: vi.fn(),
  recoverOrphanChrome: vi.fn(),
  launchBrowser: vi.fn(),
  ensureBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  isBrowserConnected: vi.fn(),
  safePages: vi.fn(),
  unfreezePages: vi.fn(),
};

const createRuntime = vi.fn(() => runtimeApi);

vi.mock('@site-use/runtime', () => ({
  createRuntime,
}));

describe('browser compatibility wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('delegates safePages() to the runtime instance', async () => {
    const browser = { targets: vi.fn() } as unknown as Browser;
    const pages = [{ url: () => 'https://x.com/home' }] as unknown as Page[];
    runtimeApi.safePages.mockResolvedValue(pages);

    const { safePages } = await import('../../src/browser/browser.js');
    const result = await safePages(browser);

    expect(runtimeApi.safePages).toHaveBeenCalledWith(browser);
    expect(result).toBe(pages);
  });

  it('delegates unfreezePages() to the runtime instance', async () => {
    const pages = [{ url: () => 'https://x.com/home' }] as unknown as Page[];
    runtimeApi.unfreezePages.mockResolvedValue(undefined);

    const { unfreezePages } = await import('../../src/browser/browser.js');
    await unfreezePages(pages);

    expect(runtimeApi.unfreezePages).toHaveBeenCalledWith(pages);
  });
});
