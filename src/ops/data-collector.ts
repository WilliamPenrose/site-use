/**
 * Async data collector with condition-variable-style waiting.
 * Encapsulates push + notify into a single operation, eliminating
 * the risk of forgetting to notify after data mutation.
 */
export interface DataCollector<T> {
  /** Add items and automatically wake all waiters to re-evaluate predicates. */
  push(...items: T[]): void;
  /** Clear all data. Does NOT wake waiters (they should wait for new data). */
  clear(): void;
  /**
   * Wait until predicate returns true, or timeout.
   * - Checks predicate immediately on entry (handles signal-before-wait race)
   * - Re-checks on every push()
   * - Returns true if satisfied, false if timed out
   */
  waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  /** Current data (read-only view). */
  readonly items: readonly T[];
  /** Current item count. */
  readonly length: number;
}

export function createDataCollector<T>(): DataCollector<T> {
  const data: T[] = [];
  const listeners: Array<() => void> = [];

  function wake(): void {
    const batch = listeners.splice(0);
    for (const fn of batch) fn();
  }

  return {
    push(...items: T[]): void {
      data.push(...items);
      wake();
    },

    clear(): void {
      data.length = 0;
    },

    waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
      if (predicate()) return Promise.resolve(true);

      return new Promise<boolean>((resolve) => {
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(false);
        }, timeoutMs);

        function listener(): void {
          if (settled) return;
          if (predicate()) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          } else {
            listeners.push(listener);
          }
        }

        listeners.push(listener);
      });
    },

    get items(): readonly T[] {
      return data;
    },

    get length(): number {
      return data.length;
    },
  };
}
