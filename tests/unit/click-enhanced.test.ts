import { describe, it, expect } from 'vitest';
import { generateBezierPath, applyJitter, isPositionStable, easeInOutCubic } from '../../src/primitives/click-enhanced.js';
import { getClickEnhancementConfig } from '../../src/config.js';

describe('generateBezierPath', () => {
  it('returns at least 10 points for a non-trivial distance', () => {
    const points = generateBezierPath(100, 100, 500, 400);
    expect(points.length).toBeGreaterThanOrEqual(10);
  });

  it('starts near the origin and ends at the exact target', () => {
    const points = generateBezierPath(0, 0, 800, 600);
    const first = points[0];
    const last = points[points.length - 1];
    // First point has ±1px micro-noise
    expect(Math.abs(first.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.y)).toBeLessThanOrEqual(1);
    // Last point has no noise (exact)
    expect(last.x).toBe(800);
    expect(last.y).toBe(600);
  });

  it('points are not all collinear (has curvature)', () => {
    const points = generateBezierPath(0, 0, 400, 0);
    const hasYVariation = points.some((p) => Math.abs(p.y) > 1);
    expect(hasYVariation).toBe(true);
  });

  it('returns single point when start equals end', () => {
    const points = generateBezierPath(100, 100, 100, 100);
    expect(points.length).toBe(1);
  });
});

describe('easeInOutCubic', () => {
  it('returns 0 at t=0 and 1 at t=1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('returns 0.5 at t=0.5', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
  });

  it('moves slowly at start and end, fast in middle', () => {
    // First 20% of t should cover less than 20% of distance (slow start)
    expect(easeInOutCubic(0.2)).toBeLessThan(0.2);
    // Last 20% should cover less than 20% too (slow end)
    expect(1 - easeInOutCubic(0.8)).toBeLessThan(0.2);
    // Middle should be faster
    const mid = easeInOutCubic(0.6) - easeInOutCubic(0.4);
    const edge = easeInOutCubic(0.2) - easeInOutCubic(0.0);
    expect(mid).toBeGreaterThan(edge);
  });
});

describe('applyJitter', () => {
  it('with no box: returns coordinates within ±maxOffset (legacy mode)', () => {
    for (let i = 0; i < 100; i++) {
      const { x, y } = applyJitter(500, 300, 3);
      expect(x).toBeGreaterThanOrEqual(497);
      expect(x).toBeLessThanOrEqual(503);
      expect(y).toBeGreaterThanOrEqual(297);
      expect(y).toBeLessThanOrEqual(303);
    }
  });

  it('with box: returns coordinates within the padded bounding box', () => {
    // 200x100 box at (100, 50), center = (200, 100)
    const box = { x: 100, y: 50, width: 200, height: 100 };
    for (let i = 0; i < 200; i++) {
      const { x, y } = applyJitter(200, 100, 3, box);
      // Must stay within the box boundaries
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(50);
      expect(y).toBeLessThanOrEqual(150);
    }
  });

  it('with box: points spread beyond ±3px for large elements', () => {
    const box = { x: 0, y: 0, width: 400, height: 200 };
    let maxDist = 0;
    for (let i = 0; i < 200; i++) {
      const { x, y } = applyJitter(200, 100, 3, box);
      const dist = Math.max(Math.abs(x - 200), Math.abs(y - 100));
      if (dist > maxDist) maxDist = dist;
    }
    // For a 400x200 box, points should spread well beyond 3px
    expect(maxDist).toBeGreaterThan(10);
  });

  it('with box: distribution is center-biased (truncated normal)', () => {
    const box = { x: 0, y: 0, width: 200, height: 200 };
    let innerCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const { x, y } = applyJitter(100, 100, 3, box);
      // "Inner 50%" = within ±25% of center = [50, 150] on each axis
      if (x >= 50 && x <= 150 && y >= 50 && y <= 150) innerCount++;
    }
    // Uniform would give ~25% in inner 50% area (0.5*0.5).
    // Truncated normal should concentrate >50% of points in the inner 50%.
    expect(innerCount / N).toBeGreaterThan(0.45);
  });

  it('has randomness (does not always return the same value)', () => {
    const results = new Set<string>();
    const box = { x: 0, y: 0, width: 200, height: 100 };
    for (let i = 0; i < 20; i++) {
      const { x, y } = applyJitter(100, 50, 3, box);
      results.add(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('isPositionStable', () => {
  it('returns true when all samples are identical', () => {
    const samples = [
      { x: 100, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 200 },
    ];
    expect(isPositionStable(samples, 2)).toBe(true);
  });

  it('returns false when positions are moving', () => {
    const samples = [
      { x: 100, y: 200 },
      { x: 110, y: 210 },
      { x: 120, y: 220 },
    ];
    expect(isPositionStable(samples, 2)).toBe(false);
  });

  it('returns true when drift is within threshold', () => {
    const samples = [
      { x: 100, y: 200 },
      { x: 101, y: 200 },
      { x: 100, y: 201 },
    ];
    expect(isPositionStable(samples, 2)).toBe(true);
  });

  it('returns false when fewer samples than required', () => {
    const samples = [{ x: 100, y: 200 }];
    expect(isPositionStable(samples, 3)).toBe(false);
  });
});

describe('getClickEnhancementConfig', () => {
  it('returns all enhancements enabled by default', () => {
    const config = getClickEnhancementConfig();
    expect(config.trajectory).toBe(true);
    expect(config.coordFix).toBe(true);
    expect(config.jitter).toBe(true);
    expect(config.occlusionCheck).toBe(true);
    expect(config.stabilityWait).toBe(true);
  });

  it('respects environment variable overrides', () => {
    process.env.SITE_USE_CLICK_TRAJECTORY = 'false';
    process.env.SITE_USE_CLICK_JITTER = 'false';
    try {
      const config = getClickEnhancementConfig();
      expect(config.trajectory).toBe(false);
      expect(config.jitter).toBe(false);
      expect(config.coordFix).toBe(true);
      expect(config.occlusionCheck).toBe(true);
      expect(config.stabilityWait).toBe(true);
    } finally {
      delete process.env.SITE_USE_CLICK_TRAJECTORY;
      delete process.env.SITE_USE_CLICK_JITTER;
    }
  });
});
