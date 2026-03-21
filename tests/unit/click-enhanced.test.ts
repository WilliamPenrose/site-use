import { describe, it, expect } from 'vitest';
import { generateBezierPath, applyJitter, isPositionStable } from '../../src/primitives/click-enhanced.js';

describe('generateBezierPath', () => {
  it('returns at least 10 points for a non-trivial distance', () => {
    const points = generateBezierPath(100, 100, 500, 400);
    expect(points.length).toBeGreaterThanOrEqual(10);
  });

  it('starts near the origin and ends near the target', () => {
    const points = generateBezierPath(0, 0, 800, 600);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first.x).toBeCloseTo(0, 0);
    expect(first.y).toBeCloseTo(0, 0);
    expect(last.x).toBeCloseTo(800, 0);
    expect(last.y).toBeCloseTo(600, 0);
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

describe('applyJitter', () => {
  it('returns coordinates within ±maxOffset of the original', () => {
    const maxOffset = 3;
    for (let i = 0; i < 100; i++) {
      const { x, y } = applyJitter(500, 300, maxOffset);
      expect(x).toBeGreaterThanOrEqual(500 - maxOffset);
      expect(x).toBeLessThanOrEqual(500 + maxOffset);
      expect(y).toBeGreaterThanOrEqual(300 - maxOffset);
      expect(y).toBeLessThanOrEqual(300 + maxOffset);
    }
  });

  it('does not always return the same value (has randomness)', () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { x, y } = applyJitter(500, 300, 3);
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
