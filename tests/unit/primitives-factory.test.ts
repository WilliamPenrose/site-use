import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';
import type { SiteConfig } from '../../src/primitives/factory.js';

// Mock browser module to avoid real Chrome
vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(),
  isBrowserConnected: vi.fn().mockReturnValue(true),
}));

let buildPrimitivesStack: typeof import('../../src/primitives/factory.js').buildPrimitivesStack;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../../src/primitives/factory.js');
  buildPrimitivesStack = mod.buildPrimitivesStack;
});

function createMockBrowser(): Browser {
  const mockPage = {
    url: () => 'about:blank',
    on: vi.fn(),
    off: vi.fn(),
    evaluate: vi.fn(),
    evaluateOnNewDocument: vi.fn(),
    createCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({ nodes: [] }),
      detach: vi.fn(),
    }),
    mouse: { move: vi.fn(), click: vi.fn() },
    screenshot: vi.fn().mockResolvedValue('base64'),
    goto: vi.fn(),
    authenticate: vi.fn(),
  } as unknown as Page;

  return {
    pages: vi.fn().mockResolvedValue([mockPage]),
    newPage: vi.fn().mockResolvedValue(mockPage),
    on: vi.fn(),
    connected: true,
  } as unknown as Browser;
}

const fakeSite: SiteConfig = {
  name: 'fake',
  domains: ['fake.com'],
  detect: () => null,
  authCheck: async () => true,
};

describe('buildPrimitivesStack', () => {
  it('returns both guarded and throttled primitives', () => {
    const browser = createMockBrowser();
    const result = buildPrimitivesStack(browser, [fakeSite]);

    expect(result.guarded).toBeDefined();
    expect(result.throttled).toBeDefined();
    expect(result.guarded).not.toBe(result.throttled);
  });

  it('guarded and throttled both have all Primitives methods', () => {
    const browser = createMockBrowser();
    const { guarded, throttled } = buildPrimitivesStack(browser, [fakeSite]);

    const methods = [
      'navigate', 'takeSnapshot', 'click', 'type',
      'scroll', 'scrollIntoView', 'evaluate', 'screenshot',
      'interceptRequest', 'getRawPage',
    ];

    for (const method of methods) {
      expect(typeof (guarded as any)[method]).toBe('function');
      expect(typeof (throttled as any)[method]).toBe('function');
    }
  });

  it('works with zero sites (no auth guard, no site detectors)', () => {
    const browser = createMockBrowser();
    const { guarded, throttled } = buildPrimitivesStack(browser, []);

    expect(guarded).toBeDefined();
    expect(throttled).toBeDefined();
  });
});
