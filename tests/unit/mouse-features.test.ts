import { describe, it, expect } from 'vitest';
import {
  computeMouseFeatures,
  scoreMouse,
  mulberry32,
} from './mouse-features.js';

// A straight path with a smoothly-varying speed profile (a single eased move)
// is the archetypal bot signal: efficiency == 1 (path IS the straight line) and
// speed autocorrelation ~1 (each step's speed is almost identical to the last).
// (A perfectly CONSTANT-speed path has zero speed variance, so its lag-1
// autocorrelation is undefined (0/0) and reported as 0 — not the bot case.)
describe('computeMouseFeatures', () => {
  it('straight smoothly-accelerating path: efficiency ~1 and autocorr ~1', () => {
    // x advances by a smooth, slowly-changing step; y stays 0 (straight line).
    const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }];
    let x = 0;
    for (let i = 1; i < 40; i++) {
      const speed = 5 + 4 * Math.sin((i * Math.PI) / 40); // smooth, positive, varying
      x += speed;
      pts.push({ x, y: 0 });
    }
    const f = computeMouseFeatures(pts);
    expect(f.efficiencyRatio).toBeGreaterThan(0.98);
    expect(f.autocorrelationLag1).toBeGreaterThan(0.85); // report range ~0.88-0.94
    // Straight line trips efficiency, autocorr, and linearity.
    const s = scoreMouse(f);
    expect(s.tripped.efficiencyRatio).toBe(true);
    expect(s.tripped.autocorrelationLag1).toBe(true);
  });

  it('wiggly detour path: efficiency well below 0.6', () => {
    // Zig-zags out and back — long path, small net displacement.
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 40; i++) {
      pts.push({ x: i * 5, y: (i % 2 === 0 ? 1 : -1) * 60 });
    }
    const f = computeMouseFeatures(pts);
    expect(f.efficiencyRatio).toBeLessThan(0.6);
  });

  it('mulberry32 is deterministic for a given seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});
