import { describe, it, expect, vi } from 'vitest';
import { ensurePage } from '../ensure-page.js';
import { createDataCollector } from '../../../ops/data-collector.js';
import type { Primitives } from '../../../primitives/types.js';

function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    scrollIntoView: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('base64png'),
    interceptRequest: vi.fn().mockResolvedValue(() => {}),
    interceptRequestWithControl: vi.fn().mockResolvedValue({ cleanup: () => {}, reset: () => {} }),
    getRawPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('ensurePage', () => {
  it('returns reloaded:false when data arrives after navigate', async () => {
    const collector = createDataCollector<{ id: string }>();
    const primitives = createMockPrimitives();

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {
        collector.push({ id: '1' });
      },
    });

    expect(result.reloaded).toBe(false);
    expect(result.waits).toHaveLength(1);
    expect(result.waits[0].purpose).toBe('initial_data');
    expect(result.waits[0].satisfied).toBe(true);
  });

  it('calls afterNavigate and returns reloaded:false when data arrives via hook', async () => {
    const collector = createDataCollector<{ id: string }>();
    const primitives = createMockPrimitives();
    const afterNavigate = vi.fn().mockImplementation(async () => {
      collector.push({ id: '1' });
    });

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {},
      afterNavigate,
    });

    expect(afterNavigate).toHaveBeenCalledOnce();
    expect(result.reloaded).toBe(false);
  });

  it('reloads when no data arrives, returns reloaded:true', { timeout: 10000 }, async () => {
    const collector = createDataCollector<{ id: string }>();
    let navCount = 0;
    const primitives = createMockPrimitives();

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {
        navCount++;
        if (navCount === 2) {
          collector.push({ id: 'after-reload' });
        }
      },
    });

    expect(result.reloaded).toBe(true);
    expect(result.waits).toHaveLength(2);
    expect(result.waits[0].purpose).toBe('initial_data');
    expect(result.waits[0].satisfied).toBe(false);
    expect(result.waits[1].purpose).toBe('after_reload');
    expect(result.waits[1].satisfied).toBe(true);
  });

  it('returns two unsatisfied waits when reload also produces no data', { timeout: 10000 }, async () => {
    const collector = createDataCollector<{ id: string }>();
    const primitives = createMockPrimitives();

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {},
    });

    expect(result.reloaded).toBe(true);
    expect(result.waits).toHaveLength(2);
    expect(result.waits[0].satisfied).toBe(false);
    expect(result.waits[1].satisfied).toBe(false);
  });

  it('propagates afterNavigate exceptions without entering waitForData', async () => {
    const collector = createDataCollector<{ id: string }>();
    const primitives = createMockPrimitives();

    await expect(
      ensurePage(primitives, {
        collector,
        t0: Date.now(),
        label: 'test',
        navigate: async () => {},
        afterNavigate: async () => {
          throw new Error('login redirect');
        },
      }),
    ).rejects.toThrow('login redirect');
  });

  it('skips afterReload when not provided', { timeout: 10000 }, async () => {
    const collector = createDataCollector<{ id: string }>();
    let navCount = 0;
    const primitives = createMockPrimitives();

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {
        navCount++;
        if (navCount === 2) collector.push({ id: '1' });
      },
    });

    expect(result.reloaded).toBe(true);
    expect(result.waits[1].satisfied).toBe(true);
  });

  it('calls afterReload on reload path', { timeout: 10000 }, async () => {
    const collector = createDataCollector<{ id: string }>();
    const afterReload = vi.fn().mockImplementation(async () => {
      collector.push({ id: 'from-after-reload' });
    });
    const primitives = createMockPrimitives();

    const result = await ensurePage(primitives, {
      collector,
      t0: Date.now(),
      label: 'test',
      navigate: async () => {},
      afterReload,
    });

    expect(afterReload).toHaveBeenCalledOnce();
    expect(result.reloaded).toBe(true);
    expect(result.waits[1].satisfied).toBe(true);
  });

  it('records correct relative timing in waits', async () => {
    const collector = createDataCollector<{ id: string }>();
    const primitives = createMockPrimitives();
    const t0 = Date.now();

    const result = await ensurePage(primitives, {
      collector,
      t0,
      label: 'test',
      navigate: async () => {
        collector.push({ id: '1' });
      },
    });

    const wait = result.waits[0];
    expect(wait.startedAt).toBeGreaterThanOrEqual(0);
    expect(wait.resolvedAt).toBeGreaterThanOrEqual(wait.startedAt);
    expect(wait.startedAt).toBeLessThan(5000);
    expect(wait.resolvedAt).toBeLessThan(5000);
  });
});
