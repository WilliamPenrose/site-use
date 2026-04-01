import { describe, it, expect } from 'vitest';
import type { ScrollDelta } from '../../tools/diagnose/scroll-analyzer.js';
import { analyzeScrollTrajectory } from '../../tools/diagnose/scroll-analyzer.js';

function makeUniformDeltas(count: number, deltaY: number, intervalMs: number): ScrollDelta[] {
  return Array.from({ length: count }, (_, i) => ({
    deltaY,
    deltaX: 0,
    timestamp: i * intervalMs,
  }));
}

function makeHumanLikeDeltas(): ScrollDelta[] {
  const deltas: ScrollDelta[] = [];
  let t = 0;
  for (let i = 0; i < 15; i++) {
    const deltaY = 100 + (Math.random() * 2 - 1) * 15;
    t += 80 + (Math.random() * 2 - 1) * 32;
    deltas.push({ deltaY, deltaX: 0, timestamp: t });
  }
  return deltas;
}

describe('analyzeScrollTrajectory', () => {
  it('returns empty report for fewer than 3 events', () => {
    const deltas = makeUniformDeltas(2, 100, 50);
    const report = analyzeScrollTrajectory(deltas);
    expect(report.checks).toHaveLength(0);
    expect(report.overallScore).toBe(0);
  });

  describe('step timing CV', () => {
    it('fails for perfectly uniform intervals', () => {
      const deltas = makeUniformDeltas(20, 100, 50);
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Step timing CV');
      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
      expect(check!.value).toBeLessThan(0.01);
    });
  });

  describe('delta uniformity', () => {
    it('fails for identical deltaY values', () => {
      const deltas = makeUniformDeltas(20, 100, 50);
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Delta uniformity');
      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
    });
  });

  describe('device mode match', () => {
    it('detects mouse wheel pattern (~100px deltas)', () => {
      const deltas: ScrollDelta[] = [];
      let t = 0;
      for (let i = 0; i < 10; i++) {
        deltas.push({ deltaY: 100 + (Math.random() * 2 - 1) * 10, deltaX: 0, timestamp: t });
        t += 80 + Math.random() * 40;
      }
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Device mode match');
      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.value).toBeGreaterThanOrEqual(80);
      expect(check!.value).toBeLessThanOrEqual(150);
    });

    it('detects trackpad pattern (small frequent deltas)', () => {
      const deltas: ScrollDelta[] = [];
      let t = 0;
      for (let i = 0; i < 30; i++) {
        deltas.push({ deltaY: 5 + Math.random() * 10, deltaX: 0, timestamp: t });
        t += 16 + Math.random() * 5;
      }
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Device mode match');
      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.value).toBeGreaterThanOrEqual(1);
      expect(check!.value).toBeLessThanOrEqual(50);
    });

    it('flags unknown device for 60px deltas', () => {
      const deltas = makeUniformDeltas(10, 60, 50);
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Device mode match');
      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
    });
  });

  describe('curvature entropy', () => {
    it('is skipped for pure vertical scroll', () => {
      const deltas = makeUniformDeltas(20, 100, 50);
      const report = analyzeScrollTrajectory(deltas);
      const check = report.checks.find(c => c.name === 'Curvature entropy');
      expect(check).toBeUndefined();
    });
  });

  describe('overall', () => {
    it('human-like deltas score reasonably', () => {
      const deltas = makeHumanLikeDeltas();
      const report = analyzeScrollTrajectory(deltas);
      expect(report.checks.length).toBeGreaterThanOrEqual(3);
      const device = report.checks.find(c => c.name === 'Device mode match');
      expect(device?.pass).toBe(true);
    });
  });
});
