import type { Page } from 'puppeteer-core';

export interface Point {
  x: number;
  y: number;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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

  const minSteps = 25;
  const fittsIndex = Math.log2(distance / 10 + 1);
  const numSteps = steps ?? Math.max(minSteps, Math.ceil((fittsIndex + 2) * 3));
  const spread = Math.max(2, Math.min(200, distance * 0.3));
  const cp1x = startX + dx * 0.25 + (Math.random() - 0.5) * spread;
  const cp1y = startY + dy * 0.25 + (Math.random() - 0.5) * spread;
  const cp2x = startX + dx * 0.75 + (Math.random() - 0.5) * spread;
  const cp2y = startY + dy * 0.75 + (Math.random() - 0.5) * spread;
  const points: Point[] = [];

  for (let i = 0; i <= numSteps; i++) {
    const linearT = i / numSteps;
    const easedT = easeInOutCubic(linearT);
    const inverseT = 1 - easedT;
    const x =
      inverseT * inverseT * inverseT * startX +
      3 * inverseT * inverseT * easedT * cp1x +
      3 * inverseT * easedT * easedT * cp2x +
      easedT * easedT * easedT * endX;
    const y =
      inverseT * inverseT * inverseT * startY +
      3 * inverseT * inverseT * easedT * cp1y +
      3 * inverseT * easedT * easedT * cp2y +
      easedT * easedT * easedT * endY;

    if (i === numSteps) {
      points.push({ x: Math.round(x), y: Math.round(y) });
    } else {
      const noiseX = (Math.random() - 0.5) * 2;
      const noiseY = (Math.random() - 0.5) * 2;
      points.push({ x: Math.round(x + noiseX), y: Math.round(y + noiseY) });
    }
  }

  return points;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function truncatedNormal(stddev: number = 0.4): number {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-1, Math.min(1, z * stddev));
}

export function applyJitter(
  x: number,
  y: number,
  maxOffset: number = 3,
  box?: BoundingBox,
  paddingPct: number = 15,
): Point {
  if (!box) {
    return {
      x: x + (Math.random() * 2 - 1) * maxOffset,
      y: y + (Math.random() * 2 - 1) * maxOffset,
    };
  }

  const padX = (box.width * paddingPct) / 100;
  const padY = (box.height * paddingPct) / 100;
  const minX = box.x + padX / 2;
  const maxX = box.x + box.width - padX / 2;
  const minY = box.y + padY / 2;
  const maxY = box.y + box.height - padY / 2;
  const halfWidth = (maxX - minX) / 2;
  const halfHeight = (maxY - minY) / 2;
  const centerX = minX + halfWidth;
  const centerY = minY + halfHeight;
  const jitteredX = centerX + truncatedNormal() * halfWidth;
  const jitteredY = centerY + truncatedNormal() * halfHeight;

  return {
    x: Math.max(box.x, Math.min(box.x + box.width, jitteredX)),
    y: Math.max(box.y, Math.min(box.y + box.height, jitteredY)),
  };
}

export async function injectCoordFix(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const screenXDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
    const screenYDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');

    if (screenXDesc && screenXDesc.configurable) {
      Object.defineProperty(MouseEvent.prototype, 'screenX', {
        get() {
          return this.clientX + window.screenX;
        },
        configurable: true,
      });
    }

    if (screenYDesc && screenYDesc.configurable) {
      Object.defineProperty(MouseEvent.prototype, 'screenY', {
        get() {
          return this.clientY + window.screenY;
        },
        configurable: true,
      });
    }
  });
}

export async function checkOcclusion(
  page: Page,
  x: number,
  y: number,
  expectedBackendNodeId: number,
): Promise<{ occluded: boolean; fallback?: Point }> {
  const client = await page.createCDPSession();

  try {
    const cdpTimeout = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CDP call timeout')), 1000)),
      ]);

    const result = await cdpTimeout(client.send('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
    })) as { backendNodeId: number };

    if (result.backendNodeId === expectedBackendNodeId) {
      return { occluded: false };
    }

    try {
      const { model } = await cdpTimeout(client.send('DOM.getBoxModel', {
        backendNodeId: expectedBackendNodeId,
      })) as { model: { content: number[] } };
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

export function isPositionStable(
  samples: Point[],
  minSamples: number = 3,
  threshold: number = 2,
): boolean {
  if (samples.length < minSamples) {
    return false;
  }

  const baseX = samples[0].x;
  const baseY = samples[0].y;

  for (const sample of samples) {
    if (Math.abs(sample.x - baseX) > threshold || Math.abs(sample.y - baseY) > threshold) {
      return false;
    }
  }

  return true;
}

export async function waitForElementStable(
  page: Page,
  backendNodeId: number,
  options: { timeoutMs?: number; pollIntervalMs?: number; threshold?: number } = {},
): Promise<{ center: Point; box: BoundingBox }> {
  const { timeoutMs = 3000, pollIntervalMs = 100, threshold = 2 } = options;
  const samples: Point[] = [];
  const startTime = Date.now();
  let getBoxModelFailures = 0;
  let totalPolls = 0;
  const client = await page.createCDPSession();

  try {
    let lastQuad: number[] = [];

    while (Date.now() - startTime < timeoutMs) {
      totalPolls++;
      let x: number;
      let y: number;

      try {
        const { model } = await Promise.race([
          client.send('DOM.getBoxModel', { backendNodeId }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('DOM.getBoxModel timeout')), 1000),
          ),
        ]) as { model: { content: number[] } };
        const quad = model.content;
        lastQuad = quad;
        x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      } catch {
        getBoxModelFailures++;
        samples.length = 0;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      samples.push({ x, y });
      if (samples.length > 3) {
        samples.shift();
      }

      if (isPositionStable(samples, 3, threshold)) {
        const xs = [lastQuad[0], lastQuad[2], lastQuad[4], lastQuad[6]];
        const ys = [lastQuad[1], lastQuad[3], lastQuad[5], lastQuad[7]];
        return {
          center: { x, y },
          box: {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          },
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const detail = getBoxModelFailures === totalPolls
      ? `DOM.getBoxModel failed all ${totalPolls} attempts (node may be detached or layout not ready)`
      : samples.length > 0
        ? `last position: ${JSON.stringify(samples[samples.length - 1])}`
        : `DOM.getBoxModel failed last ${getBoxModelFailures} of ${totalPolls} attempts (node became unavailable)`;
    throw new Error(`Element did not stabilize within ${timeoutMs}ms (${detail})`);
  } finally {
    await client.detach();
  }
}

function generateOvershootPoint(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  radius: number = 120,
): Point {
  const angle = Math.atan2(targetY - startY, targetX - startX);
  const spreadAngle = angle + (Math.random() - 0.5) * (Math.PI / 1.5);
  const overshootDistance = Math.random() * radius + 10;

  return {
    x: targetX + Math.cos(spreadAngle) * overshootDistance,
    y: targetY + Math.sin(spreadAngle) * overshootDistance,
  };
}

const overshootThreshold = 500;
const throttleThresholdMs = 1000;

async function movePath(
  page: Page,
  path: Point[],
  stepDelayMs: number,
): Promise<'ok' | 'throttled'> {
  for (let i = 0; i < path.length; i++) {
    const start = i === 0 ? Date.now() : 0;
    await page.mouse.move(path[i].x, path[i].y);
    if (start && Date.now() - start > throttleThresholdMs) {
      return 'throttled';
    }
    await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
  }

  return 'ok';
}

export async function clickWithTrajectory(
  page: Page,
  targetX: number,
  targetY: number,
  options: { stepDelayMs?: number; overshoot?: boolean; box?: BoundingBox } = {},
): Promise<'ok' | 'throttled'> {
  const { stepDelayMs = 18, overshoot = true } = options;
  const startX = 0;
  const startY = Math.round(Math.random() * 600);
  const finalTarget = { x: targetX, y: targetY };
  const dx = finalTarget.x - startX;
  const dy = finalTarget.y - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (overshoot && distance > overshootThreshold) {
    const overshootPoint = generateOvershootPoint(startX, startY, finalTarget.x, finalTarget.y);
    const pathToOvershoot = generateBezierPath(startX, startY, overshootPoint.x, overshootPoint.y);
    const overshootResult = await movePath(page, pathToOvershoot, stepDelayMs);
    if (overshootResult === 'throttled') {
      return 'throttled';
    }

    await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));

    const correctionPath = generateBezierPath(
      overshootPoint.x,
      overshootPoint.y,
      finalTarget.x,
      finalTarget.y,
    );
    await movePath(page, correctionPath, stepDelayMs);
  } else {
    const path = generateBezierPath(startX, startY, finalTarget.x, finalTarget.y);
    const result = await movePath(page, path, stepDelayMs);
    if (result === 'throttled') {
      return 'throttled';
    }
  }

  await page.mouse.click(finalTarget.x, finalTarget.y);
  return 'ok';
}
