import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDataCollector } from '../../src/ops/data-collector.js';

describe('DataCollector', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('push adds items and exposes via .items and .length', () => {
    const c = createDataCollector<number>();
    c.push(1, 2, 3);
    expect(c.length).toBe(3);
    expect([...c.items]).toEqual([1, 2, 3]);
  });

  it('clear empties data', () => {
    const c = createDataCollector<number>();
    c.push(1, 2);
    c.clear();
    expect(c.length).toBe(0);
    expect([...c.items]).toEqual([]);
  });

  it('waitUntil returns true immediately when predicate already satisfied', async () => {
    const c = createDataCollector<number>();
    c.push(1);
    const result = await c.waitUntil(() => c.length > 0, 3000);
    expect(result).toBe(true);
  });

  it('waitUntil returns false on timeout', async () => {
    const c = createDataCollector<number>();
    const promise = c.waitUntil(() => c.length > 0, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await promise).toBe(false);
  });

  it('waitUntil resolves when push satisfies predicate', async () => {
    const c = createDataCollector<number>();
    const promise = c.waitUntil(() => c.length >= 3, 5000);

    c.push(1);
    await vi.advanceTimersByTimeAsync(0);

    c.push(2, 3);
    const result = await promise;
    expect(result).toBe(true);
  });

  it('multiple concurrent waitUntil with different predicates', async () => {
    const c = createDataCollector<number>();
    const p1 = c.waitUntil(() => c.length >= 1, 5000);
    const p2 = c.waitUntil(() => c.length >= 3, 5000);

    c.push(1);
    expect(await p1).toBe(true);

    c.push(2, 3);
    expect(await p2).toBe(true);
  });

  it('clear does not trigger waiting predicates', async () => {
    const c = createDataCollector<number>();
    c.push(1, 2, 3);

    const promise = c.waitUntil(() => c.length > 5, 1000);

    c.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe(false);
  });

  it('push after clear wakes waiters correctly', async () => {
    const c = createDataCollector<number>();
    c.push(1, 2);
    c.clear();

    const promise = c.waitUntil(() => c.length > 0, 5000);
    c.push(10);
    expect(await promise).toBe(true);
    expect([...c.items]).toEqual([10]);
  });
});
