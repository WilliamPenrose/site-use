import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/mutex.js';

describe('Mutex', () => {
  it('allows a single caller through immediately', async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent callers in FIFO order', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    // Acquire first lock manually to queue others behind it
    await mutex.acquire();

    const p1 = mutex.run(async () => { order.push(1); });
    const p2 = mutex.run(async () => { order.push(2); });
    const p3 = mutex.run(async () => { order.push(3); });

    // None should have run yet
    expect(order).toEqual([]);

    // Release the initial lock — should drain in FIFO order
    mutex.release();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('releases lock even when fn throws', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.run(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    // Lock should be free — next run should work
    const result = await mutex.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('does not deadlock on sequential awaits', async () => {
    const mutex = new Mutex();
    const r1 = await mutex.run(async () => 'a');
    const r2 = await mutex.run(async () => 'b');
    expect(r1).toBe('a');
    expect(r2).toBe('b');
  });
});
