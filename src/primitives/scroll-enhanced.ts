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

  // Secondary axis distributed proportionally
  const secondaryStepSize = numSteps > 0 ? Math.floor(secondaryDist / numSteps) : 0;

  // Track accumulated distance to correct on last step
  let primaryAccum = 0;
  let secondaryAccum = 0;

  for (let i = 0; i < numSteps; i++) {
    const isLast = i === numSteps - 1;

    let pStep: number;
    let sStep: number;

    if (isLast) {
      // Last step: correct for accumulated jitter to preserve total distance
      pStep = primaryDist - primaryAccum;
      sStep = secondaryDist - secondaryAccum;
    } else {
      // Base step + jitter
      const pJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
      const sJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
      pStep = primaryStepSize * pJitter;
      sStep = secondaryStepSize * sJitter;
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
