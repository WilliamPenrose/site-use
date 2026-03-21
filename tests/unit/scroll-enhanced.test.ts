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

  it('produces single wheel call at scrollSpeed=100', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 100, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
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
