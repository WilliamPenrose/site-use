import { describe, it, expect } from 'vitest';
import { generateHumanizedPath } from '../../packages/runtime/src/internal/primitives/trajectory.js';
import { generateBezierPath } from '../../packages/runtime/src/internal/primitives/click-enhanced.js';
import { computeMouseFeatures, scoreMouse, mulberry32 } from './mouse-features.js';

const N = 500;

// Deterministic spread of start/target pairs across distances/directions.
function scenario(i: number): { start: { x: number; y: number }; target: { x: number; y: number } } {
  const r = mulberry32(1000 + i);
  const start = { x: Math.round(r() * 200), y: Math.round(r() * 600) };
  const target = { x: 200 + Math.round(r() * 1000), y: Math.round(r() * 700) };
  return { start, target };
}

function humanizedTripRates() {
  const trips = { autocorrelationLag1: 0, efficiencyRatio: 0, speedCV: 0, accelerationCV: 0, linearityScore: 0, angleChangeStd: 0 };
  const scores: number[] = [];
  let automated = 0;
  for (let i = 0; i < N; i++) {
    const { start, target } = scenario(i);
    const pts = generateHumanizedPath(start, target, { rng: mulberry32(7000 + i) });
    const s = scoreMouse(computeMouseFeatures(pts));
    scores.push(s.totalScore);
    if (s.isAutomated) automated++;
    for (const k of Object.keys(trips) as (keyof typeof trips)[]) if (s.tripped[k]) trips[k]++;
  }
  scores.sort((a, b) => a - b);
  return { trips, automated, median: scores[Math.floor(scores.length / 2)] };
}

function baselineTripRates() {
  const trips = { autocorrelationLag1: 0, efficiencyRatio: 0, speedCV: 0, accelerationCV: 0, linearityScore: 0, angleChangeStd: 0 };
  for (let i = 0; i < N; i++) {
    const { start, target } = scenario(i);
    const pts = generateBezierPath(start.x, start.y, target.x, target.y);
    const s = scoreMouse(computeMouseFeatures(pts));
    for (const k of Object.keys(trips) as (keyof typeof trips)[]) if (s.tripped[k]) trips[k]++;
  }
  return trips;
}

describe('trajectory detection gate', () => {
  it('baseline single-Bezier reproduces the autocorr/efficiency problem', () => {
    const b = baselineTripRates();
    // Current generation trips both on a large majority of runs.
    expect(b.autocorrelationLag1 / N).toBeGreaterThan(0.5);
    expect(b.efficiencyRatio / N).toBeGreaterThan(0.5);
  });

  it('humanized path keeps autocorr and efficiency trip rates under 10%', () => {
    const { trips } = humanizedTripRates();
    expect(trips.autocorrelationLag1 / N).toBeLessThan(0.1);
    expect(trips.efficiencyRatio / N).toBeLessThan(0.1);
  });

  it('humanized path is never flagged and stays low-score', () => {
    const { automated, median } = humanizedTripRates();
    expect(automated).toBe(0);
    expect(median).toBeLessThanOrEqual(0.15);
  });

  it('the other four features do not regress versus baseline', () => {
    const h = humanizedTripRates().trips;
    const b = baselineTripRates();
    for (const k of ['speedCV', 'accelerationCV', 'linearityScore', 'angleChangeStd'] as const) {
      // Humanized must be no worse than the current baseline on each guard dim.
      expect(h[k]).toBeLessThanOrEqual(b[k]);
    }
  });
});
