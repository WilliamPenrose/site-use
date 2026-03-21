# Scroll Humanization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Humanize the scroll primitive with ghost-cursor-aligned step sizing, per-step jitter, randomized inter-step delays, and a new scrollIntoView primitive with 3-tier fallback.

**Architecture:** New `scroll-enhanced.ts` file (parallel to `click-enhanced.ts`) exports `humanScroll()` and `scrollElementIntoView()`. `puppeteer-backend.ts` delegates to these when `ScrollEnhancementConfig.humanize` is true. A new `scrollIntoView(uid)` method is added to the `Primitives` interface.

**Tech Stack:** TypeScript, Puppeteer CDP, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-scroll-humanization-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/primitives/scroll-enhanced.ts` | **New.** `humanScroll()` — step sizing, jitter, delays. `scrollElementIntoView()` — viewport check, fallback chain. Internal helper `linearScale()`. |
| `src/config.ts` | Add `ScrollEnhancementConfig` interface + `getScrollEnhancementConfig()` getter. |
| `src/primitives/types.ts` | Add `scrollIntoView` to `Primitives` interface. |
| `src/primitives/puppeteer-backend.ts` | `scroll()` delegates to `humanScroll()`. New `scrollIntoView()` with uid guard. |
| `src/primitives/throttle.ts` | Add `scrollIntoView` entry. |
| `tests/unit/scroll-enhanced.test.ts` | **New.** Unit tests for `humanScroll` and `scrollElementIntoView`. |

---

### Task 1: Config — ScrollEnhancementConfig

**Files:**
- Modify: `src/config.ts:55-82`
- Modify: `tests/unit/config.test.ts` (add scroll config tests, see `tests/unit/click-enhanced.test.ts:152-177` for pattern)

- [ ] **Step 1: Write failing test for default scroll config**

In `tests/unit/config.test.ts`, add after the existing `getClickEnhancementConfig` describe block:

```typescript
describe('getScrollEnhancementConfig', () => {
  it('returns humanize enabled by default', () => {
    const config = getScrollEnhancementConfig();
    expect(config.humanize).toBe(true);
  });

  it('respects SITE_USE_SCROLL_HUMANIZE=false', () => {
    process.env.SITE_USE_SCROLL_HUMANIZE = 'false';
    try {
      const config = getScrollEnhancementConfig();
      expect(config.humanize).toBe(false);
    } finally {
      delete process.env.SITE_USE_SCROLL_HUMANIZE;
    }
  });
});
```

Also add `getScrollEnhancementConfig` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: FAIL — `getScrollEnhancementConfig` is not exported from config.

- [ ] **Step 3: Implement ScrollEnhancementConfig**

In `src/config.ts`, add after the `ClickEnhancementConfig` section (after line 82):

```typescript
export interface ScrollEnhancementConfig {
  /** Enable humanized scrolling (step jitter + random delays). Default: true */
  humanize: boolean;
}

export function getScrollEnhancementConfig(): ScrollEnhancementConfig {
  return {
    humanize: envBool('SITE_USE_SCROLL_HUMANIZE', true),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: Clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat(scroll): add ScrollEnhancementConfig with SITE_USE_SCROLL_HUMANIZE toggle"
```

---

### Task 2: humanScroll — core scroll humanization

**Files:**
- Create: `src/primitives/scroll-enhanced.ts`
- Create: `tests/unit/scroll-enhanced.test.ts`

- [ ] **Step 1: Write failing tests for humanScroll**

Create `tests/unit/scroll-enhanced.test.ts`:

```typescript
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
    // 600 / 60 = 10 steps, jitter may vary ±1
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
    // 100 / 1 = 100 steps
    expect(calls.length).toBeGreaterThanOrEqual(95);
  });

  it('total deltaY sums to approximately the requested amount', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const totalDeltaY = calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    // Jitter ±10% per step, but total should be preserved
    expect(totalDeltaY).toBeCloseTo(600, -1);
  });

  it('step deltas have jitter (not all identical)', async () => {
    const page = createMockPage();
    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });
    const calls = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls;
    const deltas = calls.map((c: any[]) => c[0]?.deltaY ?? 0);
    const unique = new Set(deltas.map((d: number) => d.toFixed(2)));
    // With jitter, steps should NOT all be the same value
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
    // All individual deltas should be negative
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
    const origSetTimeout = globalThis.setTimeout;
    // Capture delay values passed to setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
      if (ms !== undefined && ms > 0 && ms < 100) {
        delays.push(ms);
      }
      // Execute immediately for test speed
      if (typeof fn === 'function') fn();
      return 0 as any;
    });

    await humanScroll(page, 0, 600, { scrollSpeed: 60, scrollDelay: 0 });

    vi.restoreAllMocks();
    vi.useRealTimers();

    // Should have multiple inter-step delays, not all the same
    expect(delays.length).toBeGreaterThan(1);
    const unique = new Set(delays.map((d) => d.toFixed(2)));
    expect(unique.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/scroll-enhanced.test.ts`
Expected: FAIL — module `scroll-enhanced.js` does not exist.

- [ ] **Step 3: Implement humanScroll**

Create `src/primitives/scroll-enhanced.ts`:

```typescript
import type { Page } from 'puppeteer-core';

// --- Internal constants ---

const DEFAULT_SCROLL_SPEED = 60;
const DEFAULT_SCROLL_DELAY = 200;
const DEFAULT_STEP_DELAY_BASE = 20;
const DEFAULT_STEP_DELAY_JITTER = 0.3;
const DEFAULT_STEP_SIZE_JITTER = 0.1;

/** Exponential scaling kicks in above this scrollSpeed value. */
const EXP_SCALE_START = 90;

/** Linear interpolation between two ranges (from ghost-cursor math.ts). */
function linearScale(
  value: number,
  [fromLow, fromHigh]: [number, number],
  [toLow, toHigh]: [number, number],
): number {
  return ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface HumanScrollOptions {
  /** Pixels per step (1-89) or exponential scale (90-100). Default: 60 */
  scrollSpeed?: number;
  /** Post-scroll delay in ms. Default: 200 */
  scrollDelay?: number;
  /** Base inter-step delay in ms. Default: 20 */
  stepDelayBase?: number;
  /** Inter-step delay jitter factor (0-1). Default: 0.3 */
  stepDelayJitter?: number;
  /** Step size jitter factor (0-1). Default: 0.1 */
  stepSizeJitter?: number;
}

/**
 * Humanized page scroll via multiple mouse wheel events.
 *
 * Step sizing from ghost-cursor: scrollSpeed controls pixels per step (1-89)
 * or exponential scale to full distance (90-100).
 *
 * Site-use enhancements: per-step size jitter (±10%) and randomized
 * inter-step delays (base 20ms ±30%).
 */
export async function humanScroll(
  page: Page,
  deltaX: number,
  deltaY: number,
  options: HumanScrollOptions = {},
): Promise<void> {
  const {
    scrollSpeed: rawSpeed = DEFAULT_SCROLL_SPEED,
    scrollDelay = DEFAULT_SCROLL_DELAY,
    stepDelayBase = DEFAULT_STEP_DELAY_BASE,
    stepDelayJitter = DEFAULT_STEP_DELAY_JITTER,
    stepSizeJitter = DEFAULT_STEP_SIZE_JITTER,
  } = options;

  const scrollSpeed = clamp(rawSpeed, 1, 100);

  const absDeltaX = Math.abs(deltaX);
  const absDeltaY = Math.abs(deltaY);
  const xSign = deltaX < 0 ? -1 : 1;
  const ySign = deltaY < 0 ? -1 : 1;

  // Determine primary (larger) and secondary (shorter) axes
  const primaryIsX = absDeltaX > absDeltaY;
  const primaryDist = primaryIsX ? absDeltaX : absDeltaY;
  const secondaryDist = primaryIsX ? absDeltaY : absDeltaX;

  if (primaryDist === 0 && secondaryDist === 0) {
    // Nothing to scroll — skip wheel calls, still apply post-delay
    if (scrollDelay > 0) {
      await new Promise((r) => setTimeout(r, scrollDelay));
    }
    return;
  }

  // Step size for the primary axis (ghost-cursor algorithm)
  const primaryStepSize =
    scrollSpeed < EXP_SCALE_START
      ? scrollSpeed
      : linearScale(scrollSpeed, [EXP_SCALE_START, 100], [EXP_SCALE_START, primaryDist]);

  const numSteps = Math.max(1, Math.floor(primaryDist / primaryStepSize));
  const primaryRemainder = primaryDist - numSteps * primaryStepSize;

  // Secondary axis distributed proportionally
  const secondaryStepSize = numSteps > 0 ? Math.floor(secondaryDist / numSteps) : 0;
  const secondaryRemainder = secondaryDist - numSteps * secondaryStepSize;

  // Track accumulated jitter error to correct on last step
  let primaryAccum = 0;
  let secondaryAccum = 0;

  for (let i = 0; i < numSteps; i++) {
    const isLast = i === numSteps - 1;

    // Base step values
    let pStep = primaryStepSize + (isLast ? primaryRemainder : 0);
    let sStep = secondaryStepSize + (isLast ? secondaryRemainder : 0);

    if (isLast) {
      // Last step: correct for accumulated jitter to preserve total distance
      pStep = primaryDist - primaryAccum;
      sStep = secondaryDist - secondaryAccum;
    } else {
      // Apply jitter: ±stepSizeJitter
      const pJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
      const sJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
      pStep = pStep * pJitter;
      sStep = sStep * sJitter;
    }

    primaryAccum += pStep;
    secondaryAccum += sStep;

    // Map back to X/Y with correct signs:
    // primary axis → pStep, secondary axis → sStep
    const wheelDeltaX = primaryIsX ? pStep * xSign : sStep * xSign;
    const wheelDeltaY = primaryIsX ? sStep * ySign : pStep * ySign;

    await page.mouse.wheel({ deltaX: wheelDeltaX, deltaY: wheelDeltaY });

    // Inter-step delay (skip after last step)
    if (!isLast && stepDelayBase > 0) {
      const jitterRange = stepDelayBase * stepDelayJitter;
      const delay = stepDelayBase + (Math.random() * 2 - 1) * jitterRange;
      await new Promise((r) => setTimeout(r, Math.max(0, delay)));
    }
  }

  // Post-scroll delay
  if (scrollDelay > 0) {
    await new Promise((r) => setTimeout(r, scrollDelay));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/scroll-enhanced.test.ts`
Expected: PASS for all 8 humanScroll tests.

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/primitives/scroll-enhanced.ts tests/unit/scroll-enhanced.test.ts
git commit -m "feat(scroll): add humanScroll with step sizing, jitter, and randomized delays"
```

---

### Task 3: scrollElementIntoView — viewport check + fallback chain

**Files:**
- Modify: `src/primitives/scroll-enhanced.ts`
- Modify: `tests/unit/scroll-enhanced.test.ts`

- [ ] **Step 1: Write failing tests for scrollElementIntoView**

Append to `tests/unit/scroll-enhanced.test.ts`:

```typescript
describe('scrollElementIntoView', () => {
  let scrollElementIntoView: typeof import('../../src/primitives/scroll-enhanced.js').scrollElementIntoView;

  // Mock CDP session
  function createMockCDPSession(boxModel: any, viewport: any = { innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }) {
    return {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'DOM.getBoxModel') {
          return Promise.resolve(boxModel);
        }
        if (method === 'DOM.scrollIntoViewIfNeeded') {
          return Promise.resolve();
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'obj-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockPageWithCDP(session: any, viewport: any = { innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }): Page {
    return {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      createCDPSession: vi.fn().mockResolvedValue(session),
      evaluate: vi.fn().mockResolvedValue(viewport),
    } as unknown as Page;
  }

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/primitives/scroll-enhanced.js');
    scrollElementIntoView = mod.scrollElementIntoView;
  });

  it('skips scroll when element is already in viewport', async () => {
    // Element at (100,100) to (200,200) — well within 1280x720 viewport
    const session = createMockCDPSession({
      model: { content: [100, 100, 200, 100, 200, 200, 100, 200] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42);
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('scrolls down when element is below viewport', async () => {
    // Element at y=800-900, viewport height=720, scrollY=0
    const session = createMockCDPSession({
      model: { content: [100, 800, 200, 800, 200, 900, 100, 900] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // Total deltaY should be positive (scroll down)
    const totalDeltaY = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeGreaterThan(0);
  });

  it('scrolls up when element is above viewport', async () => {
    // Element at y=-100 to -50 (above current scroll position)
    const session = createMockCDPSession({
      model: { content: [100, -100, 200, -100, 200, -50, 100, -50] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    const totalDeltaY = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaY ?? 0), 0,
    );
    expect(totalDeltaY).toBeLessThan(0);
  });

  it('scrolls right when element is off-screen horizontally', async () => {
    // Element at x=1400-1500, viewport width=1280
    const session = createMockCDPSession({
      model: { content: [1400, 100, 1500, 100, 1500, 200, 1400, 200] },
    });
    const page = createMockPageWithCDP(session);
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
    const totalDeltaX = (page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum: number, c: any[]) => sum + (c[0]?.deltaX ?? 0), 0,
    );
    expect(totalDeltaX).toBeGreaterThan(0);
  });

  it('falls back to JS scrollIntoView when CDP getBoxModel fails', async () => {
    const session = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'DOM.getBoxModel') {
          return Promise.reject(new Error('Node not found'));
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'obj-1' } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const mockEvaluateHandle = vi.fn().mockResolvedValue({
      evaluate: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const page = {
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      createCDPSession: vi.fn().mockResolvedValue(session),
      evaluate: vi.fn().mockResolvedValue({ innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollX: 0 }),
    } as unknown as Page;

    // Should not throw — falls back gracefully
    await scrollElementIntoView(page, 42, { scrollDelay: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/scroll-enhanced.test.ts`
Expected: FAIL — `scrollElementIntoView` is not exported.

- [ ] **Step 3: Implement scrollElementIntoView**

Add to `src/primitives/scroll-enhanced.ts`:

```typescript
export interface ScrollIntoViewOptions extends HumanScrollOptions {
  /** Extra margin around element for viewport check (px). Default: 0 */
  inViewportMargin?: number;
}

/**
 * Scroll an element into view with humanized scrolling.
 *
 * Decision tree:
 * 1. If element is in viewport (with margin) → no-op
 * 2. If scrollSpeed=100 and no margin → CDP DOM.scrollIntoViewIfNeeded (fast path)
 * 3. Otherwise → calculate delta and humanScroll()
 * 4. On any failure → JS element.scrollIntoView() fallback
 */
export async function scrollElementIntoView(
  page: Page,
  backendNodeId: number,
  options: ScrollIntoViewOptions = {},
): Promise<void> {
  const {
    inViewportMargin = 0,
    scrollSpeed: rawSpeed = DEFAULT_SCROLL_SPEED,
    scrollDelay = DEFAULT_SCROLL_DELAY,
    ...scrollOptions
  } = options;

  const scrollSpeed = clamp(rawSpeed, 1, 100);
  const client = await page.createCDPSession();

  try {
    // Get element bounding box
    let elemBox: { top: number; left: number; bottom: number; right: number };
    try {
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId });
      const quad = model.content as number[];
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      elemBox = {
        top: Math.min(...ys),
        left: Math.min(...xs),
        bottom: Math.max(...ys),
        right: Math.max(...xs),
      };
    } catch {
      // Cannot get box model — fall back to JS scrollIntoView
      await jsFallbackScroll(client, backendNodeId, scrollSpeed);
      return;
    }

    // Get viewport dimensions
    const viewport = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
    }));

    // Viewport check with margin
    const marginedBox = {
      top: elemBox.top - inViewportMargin,
      left: elemBox.left - inViewportMargin,
      bottom: elemBox.bottom + inViewportMargin,
      right: elemBox.right + inViewportMargin,
    };

    const isInViewport =
      marginedBox.top >= 0 &&
      marginedBox.left >= 0 &&
      marginedBox.bottom <= viewport.innerHeight &&
      marginedBox.right <= viewport.innerWidth;

    if (isInViewport) return;

    // CDP fast path: scrollSpeed=100 and no margin
    if (scrollSpeed === 100 && inViewportMargin <= 0) {
      try {
        const { object } = await client.send('DOM.resolveNode', { backendNodeId });
        await client.send('DOM.scrollIntoViewIfNeeded', { objectId: object.objectId });
        if (scrollDelay > 0) {
          await new Promise((r) => setTimeout(r, scrollDelay));
        }
        return;
      } catch {
        // Fall through to humanized scroll
      }
    }

    // Calculate deltas
    let deltaY = 0;
    let deltaX = 0;

    if (marginedBox.top < 0) {
      deltaY = marginedBox.top; // scroll up
    } else if (marginedBox.bottom > viewport.innerHeight) {
      deltaY = marginedBox.bottom - viewport.innerHeight; // scroll down
    }

    if (marginedBox.left < 0) {
      deltaX = marginedBox.left; // scroll left
    } else if (marginedBox.right > viewport.innerWidth) {
      deltaX = marginedBox.right - viewport.innerWidth; // scroll right
    }

    await humanScroll(page, deltaX, deltaY, { scrollSpeed, scrollDelay, ...scrollOptions });
  } finally {
    await client.detach();
  }
}

/** JS fallback: resolve node and call element.scrollIntoView() */
async function jsFallbackScroll(
  client: any,
  backendNodeId: number,
  scrollSpeed: number,
): Promise<void> {
  try {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId });
    // Use Runtime.callFunctionOn to call scrollIntoView on the element
    const behavior = scrollSpeed < 90 ? "'smooth'" : 'undefined';
    await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: ${behavior} });
      }`,
      awaitPromise: false,
    });
  } catch {
    // Last resort failed — nothing more we can do
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit tests/unit/scroll-enhanced.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/primitives/scroll-enhanced.ts tests/unit/scroll-enhanced.test.ts
git commit -m "feat(scroll): add scrollElementIntoView with viewport check and fallback chain"
```

---

### Task 4: Interface + Throttle — add scrollIntoView to Primitives

**Files:**
- Modify: `src/primitives/types.ts:50-94`
- Modify: `src/primitives/throttle.ts:29-43`

- [ ] **Step 1: Add scrollIntoView to Primitives interface**

In `src/primitives/types.ts`, add after the `scroll` method (after line 67):

```typescript
  /** Scroll element into view if not already visible. */
  scrollIntoView(uid: string, site?: string): Promise<void>;
```

- [ ] **Step 2: Add scrollIntoView to throttle wrapper**

In `src/primitives/throttle.ts`, add after the `scroll` line (after line 34):

```typescript
    scrollIntoView: (uid, site?) => throttled(() => inner.scrollIntoView(uid, site)),
```

- [ ] **Step 3: Build to check for type errors**

Run: `pnpm run build`
Expected: FAIL — `PuppeteerBackend` does not implement `scrollIntoView` yet. This is expected; we fix it in Task 5.

- [ ] **Step 4: Commit interface changes**

```bash
git add src/primitives/types.ts src/primitives/throttle.ts
git commit -m "feat(scroll): add scrollIntoView to Primitives interface and throttle wrapper"
```

---

### Task 5: Integration — wire up puppeteer-backend

**Files:**
- Modify: `src/primitives/puppeteer-backend.ts:1-10` (imports), `236-256` (scroll), add new method
- Modify: `tests/unit/puppeteer-backend.test.ts` (add scrollIntoView tests)

- [ ] **Step 1: Write failing tests for backend integration**

In `tests/unit/puppeteer-backend.test.ts`, add the scroll config mock at the top (alongside existing click config mock):

```typescript
vi.mock('../../src/config.js', () => ({
  getClickEnhancementConfig: vi.fn(() => ({
    trajectory: false,
    coordFix: false,
    jitter: false,
    occlusionCheck: false,
    stabilityWait: false,
  })),
  getScrollEnhancementConfig: vi.fn(() => ({
    humanize: false,
  })),
}));
```

Also mock the new scroll-enhanced module:

```typescript
vi.mock('../../src/primitives/scroll-enhanced.js', () => ({
  humanScroll: vi.fn().mockResolvedValue(undefined),
  scrollElementIntoView: vi.fn().mockResolvedValue(undefined),
}));
```

Add a new describe block for scrollIntoView:

```typescript
  describe('scrollIntoView', () => {
    function setupScrollIntoViewMocks() {
      const session = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return Promise.resolve({
              nodes: [
                {
                  nodeId: 'ax-1',
                  role: { value: 'button' },
                  name: { value: 'Submit' },
                  backendDOMNodeId: 101,
                  ignored: false,
                  properties: [],
                },
              ],
            });
          }
          return Promise.resolve({});
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateCDPSession.mockResolvedValue(session);
      return session;
    }

    it('throws when takeSnapshot has not been called', async () => {
      const backend = new PuppeteerBackend(mockBrowser as any);
      await expect(backend.scrollIntoView('1', 'twitter')).rejects.toThrow(/snapshot/i);
    });

    it('throws ElementNotFound when uid is not in snapshot', async () => {
      setupScrollIntoViewMocks();
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot('twitter');
      await expect(backend.scrollIntoView('999', 'twitter')).rejects.toThrow(/not found/i);
    });

    it('delegates to scrollElementIntoView with correct backendNodeId', async () => {
      setupScrollIntoViewMocks();
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.takeSnapshot('twitter');
      await backend.scrollIntoView('1', 'twitter');

      const { scrollElementIntoView } = await import('../../src/primitives/scroll-enhanced.js');
      expect(scrollElementIntoView).toHaveBeenCalledWith(page, 101);
    });
  });

  describe('scroll with humanize config', () => {
    it('uses mechanical scroll when humanize=false', async () => {
      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      // Default mock returns humanize: false
      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 600 }, 'twitter');

      // Mechanical scroll: exactly 3 wheel calls
      expect(page.mouse.wheel).toHaveBeenCalledTimes(3);
    });

    it('delegates to humanScroll when humanize=true', async () => {
      const { getScrollEnhancementConfig } = await import('../../src/config.js');
      (getScrollEnhancementConfig as ReturnType<typeof vi.fn>).mockReturnValue({ humanize: true });

      const page = createMockPage();
      mockNewPage.mockResolvedValue(page);

      const backend = new PuppeteerBackend(mockBrowser as any);
      await backend.scroll({ direction: 'down', amount: 600 }, 'twitter');

      const { humanScroll } = await import('../../src/primitives/scroll-enhanced.js');
      expect(humanScroll).toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/puppeteer-backend.test.ts`
Expected: FAIL — `backend.scrollIntoView` is not a function.

- [ ] **Step 3: Implement backend integration**

In `src/primitives/puppeteer-backend.ts`:

Update imports (around lines 3-4):
- Add `getScrollEnhancementConfig` to the existing config import: `import { getClickEnhancementConfig, getScrollEnhancementConfig } from '../config.js';`
- Add new import: `import { humanScroll, scrollElementIntoView } from './scroll-enhanced.js';`

Replace the `scroll()` method (lines 236-256) with:

```typescript
  async scroll(options: ScrollOptions, site?: string): Promise<void> {
    const page = await this.getPage(site);
    const amount = options.amount ?? 600;
    const direction = options.direction === 'up' ? -1 : 1;
    const totalDelta = amount * direction;

    const scrollConfig = getScrollEnhancementConfig();
    if (scrollConfig.humanize) {
      await humanScroll(page, 0, totalDelta);
      return;
    }

    // Fallback: mechanical scroll (original behavior)
    const STEP_COUNT = 3;
    const stepDelta = totalDelta / STEP_COUNT;
    const STEP_PAUSE_MS = 80;

    for (let i = 0; i < STEP_COUNT; i++) {
      await page.mouse.wheel({ deltaY: stepDelta });
      if (i < STEP_COUNT - 1) {
        await new Promise((r) => setTimeout(r, STEP_PAUSE_MS));
      }
    }

    // Wait for lazy-loaded content after scroll completes
    await new Promise((r) => setTimeout(r, 500));
  }

  async scrollIntoView(uid: string, site?: string): Promise<void> {
    if (this.uidToBackendNodeId.size === 0) {
      throw new Error(
        'No snapshot available. Call takeSnapshot() before scrollIntoView().',
      );
    }

    const backendNodeId = this.uidToBackendNodeId.get(uid);
    if (backendNodeId == null) {
      throw new ElementNotFound(`Element with uid "${uid}" not found in snapshot`, {
        step: 'scrollIntoView',
      });
    }

    const page = await this.getPage(site);
    await scrollElementIntoView(page, backendNodeId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit tests/unit/puppeteer-backend.test.ts`
Expected: PASS for all tests including new scrollIntoView tests.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All unit tests pass.

- [ ] **Step 6: Build**

Run: `pnpm run build`
Expected: Clean build, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/primitives/puppeteer-backend.ts tests/unit/puppeteer-backend.test.ts
git commit -m "feat(scroll): integrate humanScroll and scrollIntoView into puppeteer-backend"
```

---

### Task 6: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (unit, contract, integration if applicable).

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: Clean build.

- [ ] **Step 3: Verify no unintended changes**

Run: `git diff HEAD~4 --stat` to see all changed files across the 4 task commits.
Expected: Only the 6 files listed in the spec's file changes table.
