import { describe, it, expect } from 'vitest';
import { generateHumanizedPath } from '../../packages/runtime/src/internal/primitives/trajectory.js';
import { mulberry32 } from './mouse-features.js';

function pathLen(pts: { x: number; y: number }[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

describe('generateHumanizedPath', () => {
  it('terminal point is the exact rounded target', () => {
    const pts = generateHumanizedPath({ x: 0, y: 0 }, { x: 640, y: 480 }, { rng: mulberry32(1) });
    const last = pts[pts.length - 1];
    expect(last.x).toBe(640);
    expect(last.y).toBe(480);
  });

  it('starts within a couple px of the start', () => {
    const pts = generateHumanizedPath({ x: 0, y: 0 }, { x: 600, y: 300 }, { rng: mulberry32(2) });
    expect(Math.abs(pts[0].x)).toBeLessThanOrEqual(2);
    expect(Math.abs(pts[0].y)).toBeLessThanOrEqual(2);
  });

  it('every path is meaningfully longer than the straight-line distance', () => {
    // Structural invariant: overshoot + arc always lengthen the path. The precise
    // distributional target (efficiency < 0.6 on >90% of runs) is enforced by the
    // statistical detection gate in trajectory-detection-gate.test.ts, which also
    // drives constant tuning.
    const start = { x: 0, y: 0 };
    const target = { x: 500, y: 200 };
    const straight = Math.hypot(target.x, target.y);
    for (let s = 0; s < 20; s++) {
      const pts = generateHumanizedPath(start, target, { rng: mulberry32(s) });
      expect(pathLen(pts)).toBeGreaterThan(straight * 1.15);
    }
  });

  it('reverses direction at least once (overshoot-and-correct)', () => {
    const start = { x: 0, y: 0 };
    const target = { x: 600, y: 0 };
    const pts = generateHumanizedPath(start, target, { rng: mulberry32(4) });
    // Some step must move backward in x (past the target then back).
    let reversed = false;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x < pts[i - 1].x) { reversed = true; break; }
    }
    expect(reversed).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    const a = generateHumanizedPath({ x: 0, y: 0 }, { x: 400, y: 400 }, { rng: mulberry32(9) });
    const b = generateHumanizedPath({ x: 0, y: 0 }, { x: 400, y: 400 }, { rng: mulberry32(9) });
    expect(a).toEqual(b);
  });

  it('returns a single exact point when start equals target', () => {
    const pts = generateHumanizedPath({ x: 100, y: 100 }, { x: 100, y: 100 }, { rng: mulberry32(5) });
    expect(pts).toEqual([{ x: 100, y: 100 }]);
  });
});
