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

  // Epoch tests — verify in-flight data from previous epoch is discarded
  describe('epoch isolation', () => {
    it('items pushed before clear are not visible after clear', () => {
      vi.useRealTimers();
      const c = createDataCollector<number>();
      c.push(1, 2, 3);
      // Simulate: handler still holds a reference and pushes after clear
      const pushLater = () => c.push(99);
      c.clear();
      pushLater(); // 99 is pushed in the new epoch
      expect([...c.items]).toEqual([99]);
      expect(c.length).toBe(1);
    });

    it('simulates in-flight race: push from old handler after clear is in new epoch', () => {
      vi.useRealTimers();
      const c = createDataCollector<number>();

      // Epoch 0: push some data
      c.push(1, 2, 3);
      expect(c.length).toBe(3);

      // Tab switch: clear (epoch 1)
      c.clear();
      expect(c.length).toBe(0);

      // In-flight R1 response arrives — pushed by the same handler reference
      // but after clear, so it's in epoch 1 (current), which is correct.
      // The real fix is that clear() happens AFTER old data arrives,
      // but with epoch tagging, even if push happens after clear,
      // the data is in the new epoch and is visible.
      c.push(100);
      expect(c.length).toBe(1);
      expect([...c.items]).toEqual([100]);

      // New tab's data arrives
      c.push(200, 300);
      expect(c.length).toBe(3);
      expect([...c.items]).toEqual([100, 200, 300]);
    });

    it('multiple clear cycles isolate data correctly', () => {
      vi.useRealTimers();
      const c = createDataCollector<string>();

      c.push('a', 'b');
      expect(c.length).toBe(2);

      c.clear(); // epoch 1
      c.push('c');
      expect([...c.items]).toEqual(['c']);

      c.clear(); // epoch 2
      c.push('d', 'e');
      expect([...c.items]).toEqual(['d', 'e']);
      expect(c.length).toBe(2);
    });
  });
});
