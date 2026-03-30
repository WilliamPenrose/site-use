import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'scroll-deltas',
  name: 'Scroll event collection',
  description: 'Collect wheel events for scroll trajectory analysis',
  runtime: 'browser',
  expected: 'events collected',
  info: true,
};

interface CollectedDelta {
  deltaY: number;
  deltaX: number;
  timestamp: number;
}

const collected: CollectedDelta[] = [];

const LINE_HEIGHT = 16;

export function setup(): void {
  document.addEventListener('wheel', (e: WheelEvent) => {
    // Normalize deltaMode to pixels
    let deltaY = e.deltaY;
    let deltaX = e.deltaX;
    if (e.deltaMode === 1) {
      // LINE mode
      deltaY *= LINE_HEIGHT;
      deltaX *= LINE_HEIGHT;
    } else if (e.deltaMode === 2) {
      // PAGE mode
      deltaY *= window.innerHeight;
      deltaX *= window.innerWidth;
    }
    collected.push({ deltaY, deltaX, timestamp: e.timeStamp });
  }, { passive: true });
}

export function run(): CheckResult {
  if (collected.length === 0) {
    return { pass: true, actual: 'no wheel events (skipped)' };
  }
  return {
    pass: true,
    actual: `${collected.length} events collected`,
  };
}

/** Expose collected deltas for Node runner to read */
export function getDeltas(): CollectedDelta[] {
  return collected;
}
