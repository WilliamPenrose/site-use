/**
 * Scroll Trajectory Humanness Analyzer
 *
 * Pure-function module that evaluates whether a scroll event sequence
 * exhibits human-like characteristics. No browser/Node dependencies.
 *
 * Checks:
 * 1. Step timing CV — inter-event interval variability (Serwadda 2013)
 * 2. Speed profile — bell-shaped scroll speed curve (Flash & Hogan 1985)
 * 3. Delta uniformity — variability of deltaY values (libcaptcha)
 * 4. Device mode match — deltaY pattern matches mouse or trackpad
 * 5. Curvature entropy — only for dual-axis scrolling (Feher 2012)
 */

import { mean, stddev } from './analyzer-utils.js';
import type { HumannessCheck, HumannessReport } from './trajectory-analyzer.js';

export interface ScrollDelta {
  deltaY: number;
  deltaX: number;
  timestamp: number;
}

// ── Check 1: Step Timing CV (reused logic) ──

function checkStepTimingCV(deltas: ScrollDelta[]): HumannessCheck {
  const intervals: number[] = [];
  for (let i = 1; i < deltas.length; i++) {
    intervals.push(deltas[i].timestamp - deltas[i - 1].timestamp);
  }
  const m = mean(intervals);
  const cv = m > 0 ? stddev(intervals) / m : 0;

  return {
    name: 'Step timing CV',
    category: 'timing',
    value: cv,
    threshold: { min: 0.20 },
    pass: cv > 0.20,
    reference: 'Serwadda 2013',
  };
}

// ── Check 2: Speed Profile ──

function checkSpeedProfile(deltas: ScrollDelta[]): HumannessCheck {
  const speeds = deltas.map(d => Math.abs(d.deltaY));

  if (speeds.length < 5) {
    return {
      name: 'Speed profile',
      category: 'kinematics',
      value: 0,
      threshold: { min: 0.50 },
      pass: false,
      reference: 'Flash&Hogan 1985',
    };
  }

  const smoothed: number[] = [];
  for (let i = 0; i < speeds.length; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(speeds.length - 1, i + 1);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      sum += speeds[j];
      count++;
    }
    smoothed.push(sum / count);
  }

  const n = smoothed.length;
  const peakValue = Math.max(...smoothed);
  const peakIndex = smoothed.indexOf(peakValue);

  let score = 0;
  const criteria = 3;

  const peakRatio = peakIndex / (n - 1);
  if (peakRatio >= 0.20 && peakRatio <= 0.80) score++;

  const earlyEnd = Math.max(1, Math.floor(n * 0.20));
  if (mean(smoothed.slice(0, earlyEnd)) < peakValue * 0.50) score++;

  const lateStart = Math.min(n - 1, Math.floor(n * 0.80));
  if (mean(smoothed.slice(lateStart)) < peakValue * 0.50) score++;

  const normalizedScore = score / criteria;

  return {
    name: 'Speed profile',
    category: 'kinematics',
    value: normalizedScore,
    threshold: { min: 0.50 },
    pass: normalizedScore >= 0.50,
    reference: 'Flash&Hogan 1985',
  };
}

// ── Check 3: Delta Uniformity ──

function checkDeltaUniformity(deltas: ScrollDelta[]): HumannessCheck {
  const values = deltas.map(d => Math.abs(d.deltaY));
  const m = mean(values);
  const cv = m > 0 ? stddev(values) / m : 0;

  return {
    name: 'Delta uniformity',
    category: 'kinematics',
    value: cv,
    threshold: { min: 0.10 },
    pass: cv > 0.10,
    reference: 'libcaptcha',
  };
}

// ── Check 4: Device Mode Match ──

function checkDeviceModeMatch(deltas: ScrollDelta[]): HumannessCheck {
  const absDeltaYs = deltas.map(d => Math.abs(d.deltaY));
  absDeltaYs.sort((a, b) => a - b);
  const median = absDeltaYs[Math.floor(absDeltaYs.length / 2)];

  let device: 'mouse' | 'trackpad' | 'unknown';
  if (median >= 80 && median <= 150) {
    device = 'mouse';
  } else if (median >= 1 && median <= 50) {
    device = 'trackpad';
  } else {
    device = 'unknown';
  }

  const pass = device !== 'unknown';

  return {
    name: 'Device mode match',
    category: 'spatial',
    value: median,
    threshold: { min: 1, max: 150 },
    pass,
    reference: 'libcaptcha',
  };
}

// ── Check 5: Curvature Entropy (conditional) ──

function hasDualAxis(deltas: ScrollDelta[]): boolean {
  const withX = deltas.filter(d => Math.abs(d.deltaX) > 1).length;
  return withX / deltas.length >= 0.30;
}

function checkCurvatureEntropy(deltas: ScrollDelta[]): HumannessCheck {
  const NUM_BINS = 8;
  const bins = new Array(NUM_BINS).fill(0);
  let totalAngles = 0;

  for (let i = 1; i < deltas.length - 1; i++) {
    const prev = deltas[i - 1];
    const curr = deltas[i];
    const next = deltas[i + 1];

    const v1x = prev.deltaX - curr.deltaX;
    const v1y = prev.deltaY - curr.deltaY;
    const v2x = next.deltaX - curr.deltaX;
    const v2y = next.deltaY - curr.deltaY;

    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);

    if (mag1 === 0 || mag2 === 0) continue;

    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    const angle = Math.acos(cosAngle);

    const binIndex = Math.min(NUM_BINS - 1, Math.floor((angle / Math.PI) * NUM_BINS));
    bins[binIndex]++;
    totalAngles++;
  }

  if (totalAngles === 0) {
    return {
      name: 'Curvature entropy',
      category: 'kinematics',
      value: 0,
      threshold: { min: 0.30 },
      pass: false,
      reference: 'Feher 2012',
    };
  }

  let entropy = 0;
  for (const count of bins) {
    if (count > 0) {
      const p = count / totalAngles;
      entropy -= p * Math.log2(p);
    }
  }
  const normalizedEntropy = entropy / Math.log2(NUM_BINS);

  return {
    name: 'Curvature entropy',
    category: 'kinematics',
    value: normalizedEntropy,
    threshold: { min: 0.30 },
    pass: normalizedEntropy > 0.30,
    reference: 'Feher 2012',
  };
}

// ── Main entry point ──

/**
 * Analyze a scroll event sequence for human-like characteristics.
 *
 * @param deltas - Sequence of wheel events with deltaY, deltaX, timestamp
 * @returns HumannessReport with individual checks and overall score
 */
export function analyzeScrollTrajectory(deltas: ScrollDelta[]): HumannessReport {
  const checks: HumannessCheck[] = [];

  if (deltas.length < 3) {
    return { checks, overallScore: 0 };
  }

  checks.push(checkStepTimingCV(deltas));
  checks.push(checkSpeedProfile(deltas));
  checks.push(checkDeltaUniformity(deltas));

  const deviceCheck = checkDeviceModeMatch(deltas);
  checks.push(deviceCheck);

  if (hasDualAxis(deltas)) {
    checks.push(checkCurvatureEntropy(deltas));
  }

  const passCount = checks.filter(c => c.pass).length;
  const overallScore = checks.length > 0 ? passCount / checks.length : 0;

  return { checks, overallScore };
}
