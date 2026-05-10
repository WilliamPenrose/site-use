import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SitePlugin } from '../../src/registry/types.js';

const runtimeApi = {
  hasSite: vi.fn(),
  openSite: vi.fn(),
  clearSite: vi.fn(),
  clearAll: vi.fn(),
};

const createRuntime = vi.fn(() => runtimeApi);

vi.mock('@site-use/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@site-use/runtime')>();
  return {
    ...actual,
    createRuntime,
  };
});

function fakePlugin(name: string): SitePlugin {
  return {
    apiVersion: 1,
    name,
    domains: [`${name}.com`],
  };
}

function fakeSession(siteName: string) {
  return {
    site: { name: siteName, domains: [`${siteName}.com`] },
    primitives: { screenshot: vi.fn(), navigate: vi.fn() },
    page: { close: vi.fn(async () => {}), url: () => 'about:blank' },
    mutex: { run: vi.fn(async (fn: () => Promise<unknown>) => await fn()) },
    circuitBreaker: {
      isTripped: false,
      streak: 0,
      recordSuccess: vi.fn(),
      recordError: vi.fn(),
      reset: vi.fn(),
    },
    rateLimitDetector: {},
    authState: { loggedIn: null, lastCheckedAt: null },
    ownPage: true,
    close: vi.fn(async () => {}),
  };
}

describe('createSiteRuntimeAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeApi.hasSite.mockReturnValue(false);
    runtimeApi.openSite.mockImplementation(async (site) => fakeSession(site.name));
    runtimeApi.clearSite.mockResolvedValue(undefined);
    runtimeApi.clearAll.mockResolvedValue(undefined);
  });

  it('translates SitePlugin into RuntimeSiteDefinition via explicit access layer', async () => {
    const { createSiteRuntimeAccess } = await import('../../src/runtime/access.js');
    const access = createSiteRuntimeAccess([fakePlugin('twitter')]);

    await access.getSiteRuntime('twitter');

    expect(runtimeApi.openSite).toHaveBeenCalledWith({
      name: 'twitter',
      domains: ['twitter.com'],
      auth: undefined,
      detect: undefined,
    });
  });

  it('throws a clear error for unknown site names', async () => {
    const { createSiteRuntimeAccess } = await import('../../src/runtime/access.js');
    const access = createSiteRuntimeAccess([fakePlugin('twitter')]);

    await expect(access.getSiteRuntime('reddit')).rejects.toThrow(/Unknown site "reddit"/);
  });

  it('keeps the runtime barrel on the final access-layer surface', async () => {
    const runtimeModule = await import('../../src/runtime/index.js');

    expect(typeof runtimeModule.createSiteRuntimeAccess).toBe('function');
    expect('SiteRuntimeManager' in runtimeModule).toBe(false);
  });
});
