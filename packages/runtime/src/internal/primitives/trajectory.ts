import type { Point } from './click-enhanced.js';
import { easeInOutCubic } from './click-enhanced.js';

export interface HumanizedPathOptions {
  /** Injectable RNG for reproducible tests. Defaults to Math.random. */
  rng?: () => number;
  /** Overshoot the target then correct back. Default true. */
  overshoot?: boolean;
  /** Minimum total step budget. Default 25. */
  minSteps?: number;
  /** Overshoot distance as a fraction of travel distance. Default [0.06, 0.16]. */
  overshootFrac?: [number, number];
  /** Perpendicular arc amplitude as a fraction of segment length. Default 1.0. */
  arcSpreadFrac?: number;
  /** Per-step t-increment jitter magnitude (0..1). Default 0.6. */
  stepJitter?: number;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Build one curved sub-movement from `start` to `end` as a cubic Bezier whose
 * control points are offset PERPENDICULAR to the chord (a real arc bulge), then
 * sample it at NON-UNIFORM eased t so consecutive step sizes differ.
 *
 * - The perpendicular arc lengthens the path relative to displacement (lowers
 *   efficiencyRatio) and adds turn angle (lowers linearity / raises angleStd).
 * - Per-segment easing (slow-fast-slow) plus non-uniform t makes each step's
 *   displacement differ from the last (lowers autocorrelationLag1).
 * - `exactEnd` forces the final sample onto the rounded endpoint.
 */
function buildArcSegment(
  start: Point,
  end: Point,
  steps: number,
  rng: () => number,
  arcSpreadFrac: number,
  stepJitter: number,
  exactEnd: boolean,
): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;

  // Unit perpendicular to the chord.
  const px = -dy / len;
  const py = dx / len;

  // Signed arc amplitude with a GUARANTEED magnitude (never near-straight),
  // capped relative to segment length so it scales across distances without
  // drawing absurd full loops.
  const sign = rng() < 0.5 ? -1 : 1;
  const cap = Math.max(120, 0.7 * len);
  const mag = Math.min((0.5 + rng() * 0.6) * arcSpreadFrac * len, cap);
  const amp = sign * mag;

  // Asymmetric control points along the chord (0.25 / 0.75 with jitter),
  // offset perpendicular for the bulge.
  const b1 = 0.25 + (rng() - 0.5) * 0.1;
  const b2 = 0.75 + (rng() - 0.5) * 0.1;
  const a1 = amp * (0.6 + rng() * 0.8);
  const a2 = amp * (0.6 + rng() * 0.8);
  const cp1 = { x: start.x + dx * b1 + px * a1, y: start.y + dy * b1 + py * a1 };
  const cp2 = { x: start.x + dx * b2 + px * a2, y: start.y + dy * b2 + py * a2 };

  // Non-uniform cumulative t in [0, 1] (endpoints included).
  const cum: number[] = [0];
  for (let i = 0; i < steps - 1; i++) {
    const inc = Math.max(0.05, 1 + (rng() - 0.5) * 2 * stepJitter);
    cum.push(cum[cum.length - 1] + inc);
  }
  const total = cum[cum.length - 1] || 1;

  const pts: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const linearT = cum[i] / total;
    const t = easeInOutCubic(linearT);
    const u = 1 - t;
    const x = u * u * u * start.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * end.x;
    const y = u * u * u * start.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * end.y;
    if (i === steps - 1 && exactEnd) {
      pts.push({ x: Math.round(end.x), y: Math.round(end.y) });
    } else {
      const nx = (rng() - 0.5) * 2;
      const ny = (rng() - 0.5) * 2;
      pts.push({ x: Math.round(x + nx), y: Math.round(y + ny) });
    }
  }
  return pts;
}

/**
 * Generate a humanized pointer path from `start` to `target` as a sequence of
 * sub-movements: a ballistic segment that overshoots the target, then one or two
 * corrective segments that settle onto it. Every segment is a curved arc sampled
 * non-uniformly; seams between segments reset the step velocity. Terminal point
 * is the exact rounded target.
 *
 * This is geometry only — the caller controls timing; no delay is implied here.
 */
export function generateHumanizedPath(
  start: Point,
  target: Point,
  opts: HumanizedPathOptions = {},
): Point[] {
  // Defaults tuned against the zpAegis feature gate (500-sample lab): they land
  // efficiency at median ~0.46 (trips <1%) and autocorrelationLag1 at median
  // ~0.45 (trips ~5%), both well under their bot thresholds, with the guard
  // features clean. See tests/unit/trajectory-detection-gate.test.ts.
  const rng = opts.rng ?? Math.random;
  const overshoot = opts.overshoot ?? true;
  const arcSpreadFrac = opts.arcSpreadFrac ?? 1.3;
  const stepJitter = opts.stepJitter ?? 1.1;
  const [ofMin, ofMax] = opts.overshootFrac ?? [0.12, 0.28];
  const minSteps = opts.minSteps ?? 25;

  const D = dist(start, target);
  if (D < 1) {
    return [{ x: Math.round(target.x), y: Math.round(target.y) }];
  }

  // Existing Fitts-based total step budget (keeps duration in the current band).
  const fittsIndex = Math.log2(D / 10 + 1);
  const totalSteps = Math.max(minSteps, Math.ceil((fittsIndex + 2) * 3));

  // Waypoints: start -> [overshoot -> maybe settle] -> target.
  const waypoints: Point[] = [start];
  if (overshoot && D >= 24) {
    const ang = Math.atan2(target.y - start.y, target.x - start.x);
    const spread = (rng() - 0.5) * (Math.PI / 3); // +-30 degrees
    const ofrac = ofMin + rng() * (ofMax - ofMin);
    const od = Math.max(8, D * ofrac);
    const overshootPt = {
      x: target.x + Math.cos(ang + spread) * od,
      y: target.y + Math.sin(ang + spread) * od,
    };
    waypoints.push(overshootPt);
    // Always add a second smaller corrective waypoint between the overshoot and
    // the target (adds another seam + reversal, and more path length).
    const back = 0.25 + rng() * 0.25;
    waypoints.push({
      x: target.x + (overshootPt.x - target.x) * back,
      y: target.y + (overshootPt.y - target.y) * back,
    });
  }
  waypoints.push(target);

  // Split the step budget across segments proportional to length (min 4 each).
  const segs: Array<[Point, Point]> = [];
  for (let i = 0; i < waypoints.length - 1; i++) segs.push([waypoints[i], waypoints[i + 1]]);
  const segLens = segs.map(([a, b]) => dist(a, b));
  const lenSum = segLens.reduce((s, l) => s + l, 0) || 1;
  const segSteps = segLens.map((l) => Math.max(4, Math.round((totalSteps * l) / lenSum)));

  const path: Point[] = [];
  segs.forEach(([a, b], i) => {
    const isFinalSeg = i === segs.length - 1;
    path.push(...buildArcSegment(a, b, segSteps[i], rng, arcSpreadFrac, stepJitter, isFinalSeg));
  });
  return path;
}
