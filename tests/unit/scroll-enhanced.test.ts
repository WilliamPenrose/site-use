import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'puppeteer-core';

// Minimal mock page with mouse.wheel
function createMockPage(): Page {
  return {
    mouse: {
      wheel: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Page;
}

describe('humanScroll', () => {
  let humanScroll: typeof import('../../src/primitives/scroll-enhanced.js').humanScroll;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/primitives/scroll-enhanced.js');
    humanScroll = mod.humanScroll;
  });

  it('produces ~10 wheel calls for 600px at scrollSpeed=60', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(9);
    expect(calls.length).toBeLessThanOrEqual(11);
  });

  it('produces fewer wheel calls at scrollSpeed=100 than at scrollSpeed=60', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 100, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    // scrollSpeed=100 → ~6 steps + correction; fewer than scrollSpeed=60 (~10 steps)
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('produces many small steps at scrollSpeed=1', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 100, { scrollSpeed: 1, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(95);
  });

  it('total deltaY sums to approximately the requested amount', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const totalDeltaY = calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeCloseTo(600, -1);
  });

  it('step deltas have jitter (not all identical)', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const deltas = calls.map((c: any[]) => c[0]?.deltaY ?? 0);
    const unique = new Set(deltas.map((d: number) => d.toFixed(2)));
    expect(unique.size).toBeGreaterThan(1);
  });

  it('handles negative deltaY (scroll up)', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, -400, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const totalDeltaY = calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeCloseTo(-400, -1);
    calls.forEach((c: any[]) => {
      expect(c[0]?.deltaY).toBeLessThan(0);
    });
  });

  it('zero distance produces no wheel calls', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 0, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(0);
  });

  it('handles horizontal + vertical simultaneously', async () => {
    const page = createMockPage();
    await humanScroll(page, 300, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const totalDeltaX = calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaX ?? 0), 0,
    );
    const totalDeltaY = calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeCloseTo(600, -1);
    expect(totalDeltaX).toBeCloseTo(300, -1);
  });

  it('inter-step delays are not all identical (timing randomization)', async () => {
    vi.useFakeTimers();
    const page = createMockPage();
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
      if (ms !== undefined && ms > 0 && ms < 100) {
        delays.push(ms);
      }
      if (typeof fn === 'function') fn();
      return 0 as any;
    });

    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });

    vi.restoreAllMocks();
    vi.useRealTimers();

    expect(delays.length).toBeGreaterThan(1);
    const unique = new Set(delays.map((d) => d.toFixed(2)));
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('scrollElementIntoView', () => {
  let scrollElementIntoView: typeof import('../../src/primitives/scroll-enhanced.js').scrollElementIntoView;

  function createMockCDPSession(boxModel: any, viewport: any = { innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }) {
    return {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'DOM.getBoxModel') {
          return Promise.resolve(boxModel);
        }
        if (method === 'DOM.scrollIntoViewIfNeeded') {
          return Promise.resolve();
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'obj-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockPageWithCDP(session: any, viewport: any = { innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }): Page {
    return {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      createCDPSession: vi.fn().mockResolvedValue(session),
      evaluate: vi.fn().mockResolvedValue(viewport),
    } as unknown as Page;
  }

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/primitives/scroll-enhanced.js');
    scrollElementIntoView = mod.scrollElementIntoView;
  });

  it('skips scroll when element is already in viewport', async () => {
    const session = createMockCDPSession({
      model: { content: [100, 100, 200, 100, 200, 200, 100, 200] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42);
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('scrolls down when element is below viewport', async () => {
    const session = createMockCDPSession({
      model: { content: [100, 800, 200, 800, 200, 900, 100, 900] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    const totalDeltaY = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeGreaterThan(0);
  });

  it('scrolls up when element is above viewport', async () => {
    const session = createMockCDPSession({
      model: { content: [100, -100, 200, -100, 200, -50, 100, -50] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    const totalDeltaY = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeLessThan(0);
  });

  it('scrolls right when element is off-screen horizontally', async () => {
    const session = createMockCDPSession({
      model: { content: [1400, 100, 1500, 100, 1500, 200, 1400, 200] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    const totalDeltaX = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaX ?? 0), 0,
    );
    expect(totalDeltaX).toBeGreaterThan(0);
  });

  it('falls back to JS scrollIntoView when CDP getBoxModel fails', async () => {
    const session = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'DOM.getBoxModel') {
          return Promise.reject(new Error('Node not found'));
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'obj-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      createCDPSession: vi.fn().mockResolvedValue(session),
      evaluate: vi.fn().mockResolvedValue({ innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }),
    } as unknown as Page;

    // Should not throw — falls back gracefully
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
  });
});
