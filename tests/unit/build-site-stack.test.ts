import { describe, it, expect, vi } from 'vitest';
import { buildSiteStack } from '../../src/runtime/build-site-stack.js';
import type { SitePlugin } from '../../src/registry/types.js';
import type { Page } from 'puppeteer-core';

vi.mock('../../src/primitives/click-enhanced.js', () => ({
  injectCoordFix: vi.fn().mockResolvedValue(undefined),
  waitForElementStable: vi.fn(),
  clickWithTrajectory: vi.fn(),
}));

function mockPage(): Page {
  return {
    url: vi.fn().mockReturnValue('about:blank'),
    goto: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;
}

describe('buildSiteStack', () => {
  it('includes auth guard when guardNavigate is not set (default)', async () => {
    const check = vi.fn().mockResolvedValue({ loggedIn: true });
    const plugin: SitePlugin = {
      apiVersion: 1,
      name: 'twitter',
      domains: ['x.com'],
      capabilities: { auth: { check } },
    };
    const { primitives } = buildSiteStack(mockPage(), plugin);

    await primitives.navigate('https://x.com/home');
    // Auth guard should have called check
    expect(check).toHaveBeenCalled();
  });

  it('skips auth guard when guardNavigate is false', async () => {
    const check = vi.fn().mockResolvedValue({ loggedIn: true });
    const plugin: SitePlugin = {
      apiVersion: 1,
      name: 'xhs',
      domains: ['xiaohongshu.com'],
      capabilities: { auth: { check, guardNavigate: false } },
    };
    const { primitives } = buildSiteStack(mockPage(), plugin);

    await primitives.navigate('https://xiaohongshu.com/explore');
    // Auth guard should NOT have called check
    expect(check).not.toHaveBeenCalled();
  });
});
