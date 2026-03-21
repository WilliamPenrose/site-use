import type { Page } from 'puppeteer-core';

export interface Point {
  x: number;
  y: number;
}

/**
 * Ease-in-out cubic: slow start, fast middle, slow end.
 * Simulates natural hand acceleration/deceleration.
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Generate a cubic Bezier curve path from (startX, startY) to (endX, endY).
 * - Random control points → curved arc trajectory
 * - Ease-in-out timing → acceleration/deceleration like real hand movement
 * - Per-point micro-noise (±1px) → hand tremor simulation
 * Last point is exact (no noise) to ensure accurate final position.
 */
export function generateBezierPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps?: number,
): Point[] {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 1) {
    return [{ x: endX, y: endY }];
  }

  // Fitts' Law: logarithmic step count — fewer steps for long distances,
  // more steps for short distances compared to linear scaling.
  const MIN_STEPS = 25;
  const fittsIndex = Math.log2(distance / 10 + 1);
  const numSteps = steps ?? Math.max(MIN_STEPS, Math.ceil((fittsIndex + 2) * 3));

  const spread = Math.max(2, Math.min(200, distance * 0.3));
  const cp1x = startX + dx * 0.25 + (Math.random() - 0.5) * spread;
  const cp1y = startY + dy * 0.25 + (Math.random() - 0.5) * spread;
  const cp2x = startX + dx * 0.75 + (Math.random() - 0.5) * spread;
  const cp2y = startY + dy * 0.75 + (Math.random() - 0.5) * spread;

  const points: Point[] = [];
  for (let i = 0; i <= numSteps; i++) {
    const linearT = i / numSteps;
    const t = easeInOutCubic(linearT);
    const u = 1 - t;
    const x = u * u * u * startX + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * endX;
    const y = u * u * u * startY + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * endY;

    // Last point: no noise, ensure exact final position
    if (i === numSteps) {
      points.push({ x: Math.round(x), y: Math.round(y) });
    } else {
      // Micro-noise ±1px simulating hand tremor
      const noiseX = (Math.random() - 0.5) * 2;
      const noiseY = (Math.random() - 0.5) * 2;
      points.push({ x: Math.round(x + noiseX), y: Math.round(y + noiseY) });
    }
  }

  return points;
}

/**
 * Apply random jitter within +/-maxOffset pixels.
 */
export function applyJitter(
  x: number,
  y: number,
  maxOffset: number = 3,
): Point {
  return {
    x: x + (Math.random() * 2 - 1) * maxOffset,
    y: y + (Math.random() * 2 - 1) * maxOffset,
  };
}

/**
 * Inject MouseEvent screenX/screenY coordinate fix into a page.
 * Must be called before any navigation (uses evaluateOnNewDocument).
 *
 * Fixes: CDP Input.dispatchMouseEvent sets screenX/screenY to 0 or inconsistent values.
 * Real events satisfy: screenX === clientX + window.screenX
 */
export async function injectCoordFix(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const screenXDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
    const screenYDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');
    if (screenXDesc && screenXDesc.configurable) {
      Object.defineProperty(MouseEvent.prototype, 'screenX', {
        get() { return this.clientX + window.screenX; },
        configurable: true,
      });
    }
    if (screenYDesc && screenYDesc.configurable) {
      Object.defineProperty(MouseEvent.prototype, 'screenY', {
        get() { return this.clientY + window.screenY; },
        configurable: true,
      });
    }
  });
}

/**
 * Check if the element at (x, y) matches the expected backendNodeId.
 * Uses CDP DOM.getNodeForLocation to verify no other element is occluding the target.
 *
 * Returns { occluded: false } if the target is clickable,
 * or { occluded: true, fallback } with the element's midpoint as fallback coordinates.
 */
export async function checkOcclusion(
  page: Page,
  x: number,
  y: number,
  expectedBackendNodeId: number,
): Promise<{ occluded: boolean; fallback?: Point }> {
  const client = await page.createCDPSession();
  try {
    const result = await client.send('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
    });

    if (result.backendNodeId === expectedBackendNodeId) {
      return { occluded: false };
    }

    // Occluded — compute element midpoint as fallback
    try {
      const { model } = await client.send('DOM.getBoxModel', {
        backendNodeId: expectedBackendNodeId,
      });
      const quad = model.content;
      const midX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const midY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      return { occluded: true, fallback: { x: midX, y: midY } };
    } catch {
      return { occluded: true };
    }
  } finally {
    await client.detach();
  }
}

/**
 * Pure logic: check if a sequence of position samples indicates stability.
 * Returns true if the max drift across all samples is within threshold pixels.
 */
export function isPositionStable(
  samples: Point[],
  minSamples: number = 3,
  threshold: number = 2,
): boolean {
  if (samples.length < minSamples) return false;

  const baseX = samples[0].x;
  const baseY = samples[0].y;

  for (const s of samples) {
    if (Math.abs(s.x - baseX) > threshold || Math.abs(s.y - baseY) > threshold) {
      return false;
    }
  }
  return true;
}

/**
 * Wait until an element's position stops changing (CSS animation/transition finished).
 * Polls the element's box model every pollIntervalMs and waits until
 * consecutive readings are stable within threshold pixels.
 *
 * Throws if the element doesn't stabilize within timeoutMs.
 */
export async function waitForElementStable(
  page: Page,
  backendNodeId: number,
  options: { timeoutMs?: number; pollIntervalMs?: number; threshold?: number } = {},
): Promise<Point> {
  const { timeoutMs = 3000, pollIntervalMs = 100, threshold = 2 } = options;
  const samples: Point[] = [];
  const startTime = Date.now();

  const client = await page.createCDPSession();
  try {
    while (Date.now() - startTime < timeoutMs) {
      let x: number, y: number;
      try {
        const { model } = await client.send('DOM.getBoxModel', { backendNodeId });
        const quad = model.content;
        x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      } catch {
        // Element may be offscreen or detached — reset samples and retry
        samples.length = 0;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      samples.push({ x, y });

      // Keep only last 3 samples
      if (samples.length > 3) samples.shift();

      if (isPositionStable(samples, 3, threshold)) {
        return { x, y };
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(
      `Element did not stabilize within ${timeoutMs}ms (last position: ${JSON.stringify(samples[samples.length - 1])})`,
    );
  } finally {
    await client.detach();
  }
}

/**
 * Generate a random overshoot point near the target.
 * The overshoot lands within `radius` pixels past the target
 * along the general direction of travel, with random angular spread.
 */
function generateOvershootPoint(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  radius: number = 120,
): Point {
  const angle = Math.atan2(targetY - startY, targetX - startX);
  // Overshoot in the general forward direction with ±60° angular spread
  const spreadAngle = angle + (Math.random() - 0.5) * (Math.PI / 1.5);
  const overshootDist = Math.random() * radius + 10;
  return {
    x: targetX + Math.cos(spreadAngle) * overshootDist,
    y: targetY + Math.sin(spreadAngle) * overshootDist,
  };
}

/** Distance threshold beyond which overshoot is applied (pixels). */
const OVERSHOOT_THRESHOLD = 500;

/**
 * Move mouse along a Bezier curve from current position to (targetX, targetY),
 * then click with optional jitter.
 *
 * For long-distance moves (>500px), simulates human overshoot:
 * the cursor first moves past the target, then corrects back.
 */
export async function clickWithTrajectory(
  page: Page,
  targetX: number,
  targetY: number,
  options: { jitter?: boolean; stepDelayMs?: number; overshoot?: boolean } = {},
): Promise<void> {
  const { jitter = true, stepDelayMs = 18, overshoot = true } = options;

  const startX = 0;
  const startY = Math.round(Math.random() * 600);

  const finalTarget = jitter ? applyJitter(targetX, targetY, 3) : { x: targetX, y: targetY };

  const dx = finalTarget.x - startX;
  const dy = finalTarget.y - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (overshoot && distance > OVERSHOOT_THRESHOLD) {
    // Phase 1: Move to overshoot point (past the target)
    const overshootPt = generateOvershootPoint(startX, startY, finalTarget.x, finalTarget.y);
    const pathToOvershoot = generateBezierPath(startX, startY, overshootPt.x, overshootPt.y);

    for (const point of pathToOvershoot) {
      await page.mouse.move(point.x, point.y);
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }

    // Brief pause at overshoot — human "oops" moment
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));

    // Phase 2: Correction curve back to actual target
    const correctionPath = generateBezierPath(overshootPt.x, overshootPt.y, finalTarget.x, finalTarget.y);

    for (const point of correctionPath) {
      await page.mouse.move(point.x, point.y);
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }
  } else {
    // Direct path (short distance or overshoot disabled)
    const path = generateBezierPath(startX, startY, finalTarget.x, finalTarget.y);

    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await new Promise((r) => setTimeout(r, stepDelayMs));
    }
  }

  await page.mouse.click(finalTarget.x, finalTarget.y);
}
