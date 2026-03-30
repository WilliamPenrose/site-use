/**
 * Trajectory Humanness Analyzer
 *
 * Pure-function module that evaluates whether a mouse movement sequence
 * exhibits human-like characteristics. No browser/Node dependencies.
 *
 * Five checks based on academic literature:
 * 1. Step timing variability (CV of inter-move intervals)
 * 2. Speed profile bell-shape (correlation with minimum-jerk model)
 * 3. Curvature entropy (Shannon entropy of angular changes)
 * 4. Fitts' Law compliance (step count vs logarithmic prediction)
 * 5. Landing accuracy distribution (click offset from target center)
 */

export interface TrajectoryPoint {
  x: number;
  y: number;
  timestamp: number;
}

export interface TargetGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HumannessCheck {
  name: string;
  category: 'timing' | 'kinematics' | 'spatial';
  value: number;
  threshold: { min?: number; max?: number };
  pass: boolean;
  reference: string;
}

export interface HumannessReport {
  checks: HumannessCheck[];
  overallScore: number;
}

import { mean, stddev, pearsonR } from './analyzer-utils.js';

// ── Helper math ──

function dist(a: TrajectoryPoint, b: TrajectoryPoint): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ── Check 1: Step Timing Variability ──

/**
 * Coefficient of variation of inter-move time intervals.
 * Human CV typically 0.3-0.8; bot frameworks produce CV < 0.10.
 *
 * Reference: Serwadda & Phoha 2013
 */
function checkStepTimingCV(moves: TrajectoryPoint[]): HumannessCheck {
  const intervals: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    intervals.push(moves[i].timestamp - moves[i - 1].timestamp);
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

// ── Check 2: Speed Profile Shape ──

/**
 * Check whether the speed profile exhibits a unimodal (single-peak) shape
 * consistent with human point-to-point movement.
 *
 * Instead of correlating with a fixed polynomial, we measure:
 * - Whether speed increases then decreases (unimodal)
 * - Peak location is in the middle 60% of the trajectory
 * - First and last 20% of speeds are below 50% of peak (acceleration/deceleration)
 *
 * Robustness: works regardless of exact easing function or Bezier parameterization.
 * The score is the fraction of these sub-criteria met (0, 0.33, 0.67, or 1.0).
 *
 * Reference: Flash & Hogan 1985 — minimum-jerk model predicts bell-shaped
 * tangential velocity for point-to-point movements.
 */
function checkSpeedProfile(moves: TrajectoryPoint[]): HumannessCheck {
  // Compute spatial step lengths (proxy for speed since time intervals are ~constant)
  const steps: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    steps.push(dist(moves[i], moves[i - 1]));
  }

  if (steps.length < 5) {
    return {
      name: 'Speed profile',
      category: 'kinematics',
      value: 0,
      threshold: { min: 0.50 },
      pass: false,
      reference: 'Flash&Hogan 1985',
    };
  }

  // Smooth with a window of 3 to reduce noise
  const smoothed: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(steps.length - 1, i + 1);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      sum += steps[j];
      count++;
    }
    smoothed.push(sum / count);
  }

  const n = smoothed.length;
  const peakValue = Math.max(...smoothed);
  const peakIndex = smoothed.indexOf(peakValue);

  let score = 0;
  const criteria = 3;

  // Criterion 1: Peak is in the middle 60% (not at the very start or end)
  const peakRatio = peakIndex / (n - 1);
  if (peakRatio >= 0.20 && peakRatio <= 0.80) {
    score++;
  }

  // Criterion 2: First 20% of trajectory has average speed < 50% of peak
  const earlyEnd = Math.max(1, Math.floor(n * 0.20));
  const earlyAvg = mean(smoothed.slice(0, earlyEnd));
  if (earlyAvg < peakValue * 0.50) {
    score++;
  }

  // Criterion 3: Last 20% of trajectory has average speed < 50% of peak
  const lateStart = Math.min(n - 1, Math.floor(n * 0.80));
  const lateAvg = mean(smoothed.slice(lateStart));
  if (lateAvg < peakValue * 0.50) {
    score++;
  }

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

// ── Check 3: Curvature Entropy ──

/**
 * Shannon entropy of angular change distribution.
 * Angles between consecutive triplets, binned into 8 bins over [0, π].
 * Normalized to [0, 1] (divided by log2(numBins)).
 *
 * Reference: Feher et al. 2012
 */
function checkCurvatureEntropy(moves: TrajectoryPoint[]): HumannessCheck {
  const NUM_BINS = 8;
  const bins = new Array(NUM_BINS).fill(0);
  let totalAngles = 0;

  for (let i = 1; i < moves.length - 1; i++) {
    const prev = moves[i - 1];
    const curr = moves[i];
    const next = moves[i + 1];

    // Vectors: curr→prev and curr→next
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;

    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);

    if (mag1 === 0 || mag2 === 0) continue;

    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    const angle = Math.acos(cosAngle); // [0, π]

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

  // Shannon entropy, normalized by log2(NUM_BINS)
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

// ── Check 4: Fitts' Law Compliance ──

/**
 * Compare actual step count against Fitts' Law prediction.
 * Expected steps = k × log₂(2D/W + 1), with k calibrated so minimum = 25.
 *
 * Reference: Fitts 1954 + ISO 9241-9
 */
function checkFittsLaw(
  moves: TrajectoryPoint[],
  target: TargetGeometry,
): HumannessCheck {
  const start = moves[0];
  const end = moves[moves.length - 1];
  const D = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
  const W = Math.min(target.width, target.height);

  const fittsIndex = Math.log2(2 * D / W + 1);
  // Calibration: k such that MIN_STEPS=25 maps to a typical fittsIndex
  // For D=50, W=80: fittsIndex ≈ 1.4 → k = 25/1.4 ≈ 18
  // For D=500, W=80: fittsIndex ≈ 3.7 → expected ≈ 66
  const k = 18;
  const expectedSteps = Math.max(25, k * fittsIndex);
  const actualSteps = moves.length;

  const deviation = Math.abs(actualSteps - expectedSteps) / expectedSteps;

  return {
    name: "Fitts' Law",
    category: 'spatial',
    value: deviation,
    threshold: { max: 0.50 },
    pass: deviation < 0.50,
    reference: 'Fitts 1954',
  };
}

// ── Check 5: Landing Accuracy Distribution ──

/**
 * Euclidean distance from click point to target center.
 * Must be > 1px (not robotically precise) and < W/3 (actually aimed at target).
 *
 * Reference: Huang et al. 2012
 */
function checkLandingAccuracy(
  click: TrajectoryPoint,
  target: TargetGeometry,
): HumannessCheck {
  const offset = Math.sqrt((click.x - target.x) ** 2 + (click.y - target.y) ** 2);
  const maxOffset = Math.min(target.width, target.height) / 3;

  return {
    name: 'Landing accuracy',
    category: 'spatial',
    value: offset,
    threshold: { min: 1, max: maxOffset },
    pass: offset > 1 && offset < maxOffset,
    reference: 'Huang 2012',
  };
}

// ── Main entry point ──

/**
 * Analyze a mouse trajectory for human-like characteristics.
 *
 * @param moves - Sequence of mousemove points with timestamps
 * @param click - The final click point
 * @param target - Target element geometry (center + dimensions)
 * @returns HumannessReport with individual checks and overall score
 */
export function analyzeTrajectory(
  moves: TrajectoryPoint[],
  click: TrajectoryPoint,
  target: TargetGeometry,
): HumannessReport {
  const checks: HumannessCheck[] = [];

  // Trajectory checks require at least 3 mousemove points
  if (moves.length >= 3) {
    checks.push(checkStepTimingCV(moves));
    checks.push(checkSpeedProfile(moves));
    checks.push(checkCurvatureEntropy(moves));
    checks.push(checkFittsLaw(moves, target));
  }

  // Landing accuracy always applies
  checks.push(checkLandingAccuracy(click, target));

  const passCount = checks.filter((c) => c.pass).length;
  const overallScore = checks.length > 0 ? passCount / checks.length : 0;

  return { checks, overallScore };
}
