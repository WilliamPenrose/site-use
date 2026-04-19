import type { Page } from 'puppeteer-core';

const DEFAULT_SCROLL_SPEED = 120;
const DEFAULT_SCROLL_DELAY = 200;
const DEFAULT_STEP_DELAY_BASE = 20;
const DEFAULT_STEP_DELAY_JITTER = 0.3;
const DEFAULT_STEP_SIZE_JITTER = 0.2;
const EXP_SCALE_START = 150;

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
  scrollSpeed?: number;
  scrollDelay?: number;
  stepDelayBase?: number;
  stepDelayJitter?: number;
  stepSizeJitter?: number;
}

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
  const primaryIsX = absDeltaX > absDeltaY;
  const primaryDist = primaryIsX ? absDeltaX : absDeltaY;
  const secondaryDist = primaryIsX ? absDeltaY : absDeltaX;

  if (primaryDist === 0 && secondaryDist === 0) {
    if (scrollDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, scrollDelay));
    }
    return 'ok';
  }

  const primaryStepSize =
    scrollSpeed < EXP_SCALE_START
      ? scrollSpeed
      : linearScale(scrollSpeed, [EXP_SCALE_START, 100], [EXP_SCALE_START, primaryDist]);

  const numSteps = Math.max(1, Math.floor(primaryDist / primaryStepSize));
  const secondaryStepSize = numSteps > 0 ? Math.floor(secondaryDist / numSteps) : 0;

  let primaryAccum = 0;
  let secondaryAccum = 0;
  const rawBellScales: number[] = [];
  let bellSum = 0;

  for (let i = 0; i < numSteps; i++) {
    const t = numSteps > 1 ? i / (numSteps - 1) : 0.5;
    const scale = 0.3 + 0.7 * Math.sin(Math.PI * t);
    rawBellScales.push(scale);
    bellSum += scale;
  }

  const bellNorm = bellSum > 0 ? numSteps / bellSum : 1;
  const throttleThresholdMs = 1000;

  for (let i = 0; i < numSteps; i++) {
    const isLast = i === numSteps - 1;
    const bellScale = rawBellScales[i] * bellNorm;
    const primaryJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
    const secondaryJitter = 1 + (Math.random() * 2 - 1) * stepSizeJitter;
    const primaryStep = primaryStepSize * bellScale * primaryJitter;
    const secondaryStep = secondaryStepSize * bellScale * secondaryJitter;

    primaryAccum += primaryStep;
    secondaryAccum += secondaryStep;

    const wheelDeltaX = primaryIsX ? primaryStep * xSign : secondaryStep * xSign;
    const wheelDeltaY = primaryIsX ? secondaryStep * ySign : primaryStep * ySign;

    const start = i === 0 ? Date.now() : 0;
    await page.mouse.wheel({ deltaX: wheelDeltaX, deltaY: wheelDeltaY });
    if (start && Date.now() - start > throttleThresholdMs) {
      return 'throttled';
    }

    if (!isLast && stepDelayBase > 0) {
      const jitterRange = stepDelayBase * stepDelayJitter;
      const delay = stepDelayBase + (Math.random() * 2 - 1) * jitterRange;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
    }
  }

  const primaryRemain = primaryDist - primaryAccum;
  const secondaryRemain = secondaryDist - secondaryAccum;
  if (Math.abs(primaryRemain) > 1 || Math.abs(secondaryRemain) > 1) {
    const correctionX = primaryIsX ? primaryRemain * xSign : secondaryRemain * xSign;
    const correctionY = primaryIsX ? secondaryRemain * ySign : primaryRemain * ySign;
    await page.mouse.wheel({ deltaX: correctionX, deltaY: correctionY });
  }

  if (scrollDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, scrollDelay));
  }

  return 'ok';
}

export interface ScrollIntoViewOptions extends HumanScrollOptions {
  inViewportMargin?: number;
}

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
    let elemBox: { top: number; left: number; bottom: number; right: number };
    try {
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId }) as {
        model: { content: number[] };
      };
      const quad = model.content;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      elemBox = {
        top: Math.min(...ys),
        left: Math.min(...xs),
        bottom: Math.max(...ys),
        right: Math.max(...xs),
      };
    } catch {
      await jsFallbackScroll(client, backendNodeId, scrollSpeed);
      return;
    }

    const viewport = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
    }));

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

    if (isInViewport) {
      return;
    }

    if (scrollSpeed === 200 && inViewportMargin <= 0) {
      try {
        const { object } = await client.send('DOM.resolveNode', { backendNodeId }) as {
          object: { objectId: string };
        };
        await client.send('DOM.scrollIntoViewIfNeeded', { objectId: object.objectId });
        if (scrollDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, scrollDelay));
        }
        return;
      } catch {
        // Fall through to humanized scrolling.
      }
    }

    let deltaY = 0;
    let deltaX = 0;

    if (marginedBox.top < 0) {
      deltaY = marginedBox.top;
    } else if (marginedBox.bottom > viewport.innerHeight) {
      deltaY = marginedBox.bottom - viewport.innerHeight;
    }

    if (marginedBox.left < 0) {
      deltaX = marginedBox.left;
    } else if (marginedBox.right > viewport.innerWidth) {
      deltaX = marginedBox.right - viewport.innerWidth;
    }

    await humanScroll(page, deltaX, deltaY, { scrollSpeed, scrollDelay, ...scrollOptions });
  } finally {
    await client.detach();
  }
}

async function jsFallbackScroll(
  client: any,
  backendNodeId: number,
  scrollSpeed: number,
): Promise<void> {
  try {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId }) as {
      object: { objectId: string };
    };
    const behavior = scrollSpeed < 90 ? "'smooth'" : 'undefined';
    await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: ${behavior} });
      }`,
      awaitPromise: false,
    });
  } catch {
    // Last resort failed — nothing more we can do.
  }
}
