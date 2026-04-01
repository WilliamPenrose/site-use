/**
 * FIFO Mutex — serializes async operations so only one runs at a time.
 * Waiters are served in arrival order (fair queue).
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand lock to next waiter (stays locked)
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Run fn exclusively — acquires, executes, releases even on throw.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
