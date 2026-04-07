/**
 * Async data collector with condition-variable-style waiting.
 * Encapsulates push + notify into a single operation, eliminating
 * the risk of forgetting to notify after data mutation.
 *
 * Uses epoch tagging: clear() bumps the epoch so in-flight responses
 * from a previous phase are silently discarded. This prevents stale
 * data from leaking in after tab switches or interceptor re-registration.
 */
export interface DataCollector<T> {
  /** Add items and automatically wake all waiters to re-evaluate predicates. */
  push(...items: T[]): void;
  /**
   * Start a new epoch. Items pushed from previous epochs are discarded.
   * Waiters are NOT woken (they should wait for new data in the new epoch).
   */
  clear(): void;
  /**
   * Wait until predicate returns true, or timeout.
   * - Checks predicate immediately on entry (handles signal-before-wait race)
   * - Re-checks on every push()
   * - Returns true if satisfied, false if timed out
   */
  waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  /** Current data (read-only view, filtered to current epoch). */
  readonly items: readonly T[];
  /** Current item count (current epoch only). */
  readonly length: number;
}

export function createDataCollector<T>(): DataCollector<T> {
  let epoch = 0;
  const entries: Array<{ epoch: number; item: T }> = [];
  const listeners: Array<() => void> = [];

  function currentItems(): T[] {
    const e = epoch;
    return entries.filter(entry => entry.epoch === e).map(entry => entry.item);
  }

  function wake(): void {
    const batch = listeners.splice(0);
    for (const fn of batch) fn();
  }

  return {
    push(...items: T[]): void {
      const e = epoch;
      for (const item of items) {
        entries.push({ epoch: e, item });
      }
      wake();
    },

    clear(): void {
      epoch++;
      // Trim old entries to prevent memory leak
      let i = 0;
      while (i < entries.length) {
        if (entries[i].epoch < epoch) {
          entries.splice(i, 1);
        } else {
          i++;
        }
      }
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
      return currentItems();
    },

    get length(): number {
      return currentItems().length;
    },
  };
}
