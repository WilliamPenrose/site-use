import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';

const runtimeCreateSecurePuppeteerPrimitives = vi.fn(() => ({
  navigate: vi.fn(),
  takeSnapshot: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  pressKey: vi.fn(),
  scroll: vi.fn(),
  scrollIntoView: vi.fn(),
  evaluate: vi.fn(),
  screenshot: vi.fn(),
  interceptRequestWithControl: vi.fn(),
}));

vi.mock('@site-use/runtime/internal/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@site-use/runtime/internal/primitives')>();
  return {
    ...actual,
    createSecurePuppeteerPrimitives: runtimeCreateSecurePuppeteerPrimitives,
  };
});

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

describe('root primitives public surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('exports createSecurePuppeteerPrimitives() from the root primitives surface', async () => {
    const mod = await import('../../src/primitives/factory.js');

    expect(typeof mod.createSecurePuppeteerPrimitives).toBe('function');
    expect('buildPrimitivesStack' in mod).toBe(false);
  });

  it('delegates createSecurePuppeteerPrimitives() to runtime internals', async () => {
    const page = createMockPage();
    const mod = await import('../../src/primitives/factory.js');
    const createSecurePuppeteerPrimitives = mod.createSecurePuppeteerPrimitives as (
      options: { page: Page; throttle?: { minDelay: number; maxDelay: number } }
    ) => unknown;

    const result = createSecurePuppeteerPrimitives({
      page,
      throttle: { minDelay: 0, maxDelay: 0 },
    });

    expect(runtimeCreateSecurePuppeteerPrimitives).toHaveBeenCalledWith({
      page,
      throttle: { minDelay: 0, maxDelay: 0 },
    });
    expect(result).toBe(runtimeCreateSecurePuppeteerPrimitives.mock.results[0]?.value);
  });
});
