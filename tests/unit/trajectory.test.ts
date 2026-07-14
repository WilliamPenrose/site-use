import { describe, it, expect, vi } from 'vitest';
import {
  generateHumanizedPath,
  movePointerAlong,
} from '../../packages/runtime/src/internal/primitives/trajectory.js';
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

describe('movePointerAlong', () => {
  it('moves through every point and returns ok when not throttled', async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const page = { mouse: { move } } as any;
    const path = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }];
    const result = await movePointerAlong(page, path, 0);
    expect(result).toBe('ok');
    expect(move).toHaveBeenCalledTimes(3);
  });

  it('returns throttled when the first move exceeds the throttle threshold', async () => {
    let n = 0;
    const base = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      n++;
      // call #1 = t0 capture, call #2 = elapsed check (1500ms later)
      return n >= 2 ? base + 1500 : base;
    });
    const move = vi.fn().mockResolvedValue(undefined);
    const page = { mouse: { move } } as any;
    const result = await movePointerAlong(page, [{ x: 0, y: 0 }, { x: 5, y: 5 }], 0);
    vi.spyOn(Date, 'now').mockRestore();
    expect(result).toBe('throttled');
  });
});
