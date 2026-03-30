import type { DataCollector } from '../../ops/data-collector.js';
import type { Primitives } from '../../primitives/types.js';
import { NOOP_SPAN, type SpanHandle } from '../../trace.js';

export interface WaitRecord {
  purpose: string;
  startedAt: number;
  resolvedAt: number;
  satisfied: boolean;
  dataCount: number;
}

export interface EnsurePageConfig<T> {
  /** Data collector receiving intercepted responses */
  collector: DataCollector<T>;
  /** Timing baseline (Date.now() at workflow start) */
  t0: number;
  /** Navigate to the target page */
  navigate: (primitives: Primitives) => Promise<void>;
  /** Post-navigation hook: login check, tab switch, etc. (optional) */
  afterNavigate?: (primitives: Primitives, span: SpanHandle) => Promise<void>;
  /** Extra steps after reload: re-switch tab, etc. (optional) */
  afterReload?: (primitives: Primitives) => Promise<void>;
  /** Wait timeout in ms (default 3000) */
  waitMs?: number;
  /** Log prefix for console.error messages */
  label: string;
}

export interface EnsurePageResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

const DEFAULT_WAIT_MS = 3000;

export async function ensurePage<T>(
  primitives: Primitives,
  config: EnsurePageConfig<T>,
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsurePageResult> {
  const { collector, t0, waitMs = DEFAULT_WAIT_MS, label } = config;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(
    purpose: string,
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({
      purpose,
      startedAt,
      resolvedAt: Date.now() - t0,
      satisfied,
      dataCount: collector.length,
    });
    return satisfied;
  }

  // Step 1: Navigate
  console.error(`[site-use] ${label}: navigating...`);
  await span.span('navigate', () => config.navigate(primitives));

  // Step 2: Post-navigation hook
  if (config.afterNavigate) {
    await span.span('afterNavigate', (s) => config.afterNavigate!(primitives, s));
  }

  // Step 3: Wait for data + reload fallback
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait(
      'initial_data',
      () => collector.length > 0,
      waitMs,
    );
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData && !reloaded) {
      console.error(`[site-use] ${label}: no data, reloading...`);
      reloaded = true;
      collector.clear();
      await config.navigate(primitives);
      if (config.afterReload) await config.afterReload(primitives);
      const ok = await timedWait(
        'after_reload',
        () => collector.length > 0,
        waitMs,
      );
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', ok);
      s.set('dataCountAfterReload', collector.length);
    }
  });

  return { reloaded, waits };
}
