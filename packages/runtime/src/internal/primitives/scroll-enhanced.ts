import type { Page } from 'puppeteer-core';

// --- Internal constants ---

const DEFAULT_SCROLL_SPEED = 120;
const DEFAULT_SCROLL_DELAY = 200;
const DEFAULT_STEP_DELAY_BASE = 20;
const DEFAULT_STEP_DELAY_JITTER = 0.3;
const DEFAULT_STEP_SIZE_JITTER = 0.2;

/** Exponential scaling kicks in above this scrollSpeed value. */
const EXP_SCALE_START = 150;

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
  /** Pixels per step (1-149) or exponential scale (150-200). Default: 120 */
  scrollSpeed?: number;
  /** Post-scroll delay in ms. Default: 200 */
  scrollDelay?: number;
  /** Base inter-step delay in ms. Default: 20 */
  stepDelayBase?: number;
  /** Inter-step delay jitter factor (0-1). Default: 0.3 */
  stepDelayJitter?: number;
  /** Step size jitter factor (0-1). Default: 0.2 */
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
/**
 * Returns 'throttled' if the first wheel event takes >1s (CDP input throttled).
 * Caller should fall back to JS window.scrollBy().
 */
export async function humanScroll(
  page: Page,
  deltaX: number,
  deltaY: number,
  options: HumanScrollOptions = {},
): Promise<'ok' | 'throttled'> {
  const {
    scrollSpeed: rawSpeed = DEFAULT_SCROLL_SPEED,
    scrollDelay = DEFAULT_SCROLL_DELAY,
    stepDelayBase = DEFAULT_STEP_DELAY_BASE,
    stepDelayJitter = DEFAULT_STEP_DELAY_JITTER,
    stepSizeJitter = DEFAULT_STEP_SIZE_JITTER,
  } = options;

  const scrollSpeed = clamp(rawSpeed, 1, 200);

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
    return 'ok';
  }

  // Step size for the primary axis (ghost-cursor algorithm)
  const primaryStepSize =
    scrollSpeed < EXP_SCALE_START
      ? scrollSpeed
      : linearScale(scrollSpeed, [EXP_SCALE_START, 100], [EXP_SCALE_START, primaryDist]);

  const numSteps = Math.max(1, Math.floor(primaryDist / primaryStepSize));

  // Secondary axis distributed proportionally
  const secondaryStepSize = numSteps > 0 ? Math.floor(secondaryDist / numSteps) : 0;

  // Track accumulated distance to correct on last step
  let primaryAccum = 0;
  let secondaryAccum = 0;

  // Precompute bell-shaped speed profile and normalize so total ≈ target distance.
  // Without normalization the correction step overshoots the peak (bug).
  const rawBellScales: number[] = [];
  let bellSum = 0;
  for (let i = 0; i < numSteps; i++) {
    const t = numSteps > 1 ? i / (numSteps - 1) : 0.5;
    const s = 0.3 + 0.7 * Math.sin(Math.PI * t);
    rawBellScales.push(s);
    bellSum += s;
  }
  const bellNorm = bellSum > 0 ? numSteps / bellSum : 1;

  /** Threshold (ms): if a single CDP input event takes longer, input is throttled. */
  const THROTTLE_THRESHOLD_MS = 1000;

  for (let i = 0; i < numSteps; i++) {
    const isLast = i === numSteps - 1;

    const bellScale = rawBellScales[i] * bellNorm;

    const pJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
    const sJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
    const pStep = primaryStepSize * bellScale * pJitter;
    const sStep = secondaryStepSize * bellScale * sJitter;

    primaryAccum += pStep;
    secondaryAccum += sStep;

    // Map back to X/Y with correct signs
    const wheelDeltaX = primaryIsX ? pStep * xSign : sStep * xSign;
    const wheelDeltaY = primaryIsX ? sStep * ySign : pStep * ySign;

    // First wheel event doubles as throttle probe
    const t0 = i === 0 ? Date.now() : 0;
    await page.mouse.wheel({ deltaX: wheelDeltaX, deltaY: wheelDeltaY });
    if (t0 && Date.now() - t0 > THROTTLE_THRESHOLD_MS) return 'throttled';

    // Inter-step delay (skip after last step)
    if (!isLast && stepDelayBase > 0) {
      const jitterRange = stepDelayBase * stepDelayJitter;
      const delay = stepDelayBase + (Math.random() * 2 - 1) * jitterRange;
      await new Promise((r) => setTimeout(r, Math.max(0, delay)));
    }
  }

  // Correction step: emit a small final wheel event to match exact total distance
  const pRemain = primaryDist - primaryAccum;
  const sRemain = secondaryDist - secondaryAccum;
  if (Math.abs(pRemain) > 1 || Math.abs(sRemain) > 1) {
    const corrX = primaryIsX ? pRemain * xSign : sRemain * xSign;
    const corrY = primaryIsX ? sRemain * ySign : pRemain * ySign;
    await page.mouse.wheel({ deltaX: corrX, deltaY: corrY });
  }

  // Post-scroll delay
  if (scrollDelay > 0) {
    await new Promise((r) => setTimeout(r, scrollDelay));
  }
  return 'ok';
}

export interface ScrollIntoViewOptions extends HumanScrollOptions {
  /** Extra margin around element for viewport check (px). Default: 0 */
  inViewportMargin?: number;
}

/**
 * Scroll an element into view with humanized scrolling.
 *
 * Decision tree:
 * 1. If element is in viewport (with margin) → no-op
 * 2. If scrollSpeed=200 (max) and no margin → CDP DOM.scrollIntoViewIfNeeded (fast path)
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

  const scrollSpeed = clamp(rawSpeed, 1, 200);
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

    // CDP fast path: scrollSpeed=200 (max) and no margin
    if (scrollSpeed === 200 && inViewportMargin <= 0) {
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
