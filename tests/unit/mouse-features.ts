export interface Pt { x: number; y: number }

export interface MouseFeatures {
  speedCV: number;
  accelerationCV: number;
  linearityScore: number;
  angleChangeStd: number;
  autocorrelationLag1: number;
  efficiencyRatio: number;
  entropy: number;
}

// Decoded from BOSS zpAegis `detectAutomation`. Feature is in the bot direction
// when it crosses the threshold; totalScore sums the weights of tripped dims;
// isAutomated at >= 0.60.
export const THRESHOLDS = {
  speedCV: 0.7,
  accelerationCV: 0.6,
  linearityScore: 0.5,
  angleChangeStd: 0.35,
  autocorrelationLag1: 0.7,
  efficiencyRatio: 0.6,
  entropy: 0.1,
} as const;

export const WEIGHTS = {
  speedCV: 0.2,
  accelerationCV: 0.2,
  linearityScore: 0.2,
  angleChangeStd: 0.15,
  autocorrelationLag1: 0.15,
  efficiencyRatio: 0.1,
  entropy: 0.0,
} as const;

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (!a.length) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

// Lag-1 Pearson autocorrelation of the speed series (EXACT decoded definition).
function lag1Autocorr(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  let num = 0;
  let den = 0;
  for (let i = 0; i < v.length - 1; i++) num += (v[i] - m) * (v[i + 1] - m);
  for (let i = 0; i < v.length; i++) den += (v[i] - m) ** 2;
  return den > 0 ? num / den : 0;
}

// Directional coherence: the resultant length of the unit step-direction
// vectors. A perfectly straight path has every step pointing the same way, so
// the resultant is ~1 (bot); a curved / reversing path has steps pointing many
// ways that partly cancel, dropping it well below 0.5.
// APPROXIMATION of the decoded linearityScore, but directionally faithful:
// straight -> high, curvy -> low, which is the property the model keys on.
function computeLinearity(points: Pt[]): number {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const l = Math.hypot(dx, dy);
    if (l > 0) {
      sx += dx / l;
      sy += dy / l;
      n++;
    }
  }
  return n > 0 ? Math.hypot(sx, sy) / n : 1;
}

// Normalized Shannon entropy of quantized turn angles.
// APPROXIMATION; weight is 0.0 so it never affects totalScore.
function computeEntropy(angles: number[]): number {
  if (!angles.length) return 0;
  const bins = 8;
  const hist = new Array(bins).fill(0);
  for (const a of angles) {
    const idx = Math.min(bins - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * bins));
    hist[idx]++;
  }
  let H = 0;
  for (const c of hist) {
    if (c > 0) {
      const p = c / angles.length;
      H -= p * Math.log2(p);
    }
  }
  return H / Math.log2(bins);
}

export function computeMouseFeatures(points: Pt[]): MouseFeatures {
  const n = points.length;
  // Speed series (uniform dt -> speed proportional to step distance).
  const v: number[] = [];
  for (let i = 1; i < n; i++) {
    v.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const mv = mean(v);
  const speedCV = mv > 0 ? std(v) / mv : 0;

  // Acceleration magnitude series.
  const acc: number[] = [];
  for (let i = 1; i < v.length; i++) acc.push(Math.abs(v[i] - v[i - 1]));
  const ma = mean(acc);
  const accelerationCV = ma > 0 ? std(acc) / ma : 0;

  // Efficiency (EXACT): straight displacement / total path length.
  const first = points[0] ?? { x: 0, y: 0 };
  const last = points[n - 1] ?? { x: 0, y: 0 };
  const disp = Math.hypot(last.x - first.x, last.y - first.y);
  const pathLen = v.reduce((s, d) => s + d, 0);
  const efficiencyRatio = pathLen > 0 ? disp / pathLen : 0;

  const autocorrelationLag1 = lag1Autocorr(v);

  // Turn angles between consecutive step vectors.
  const angles: number[] = [];
  for (let i = 2; i < n; i++) {
    const ax = points[i - 1].x - points[i - 2].x;
    const ay = points[i - 1].y - points[i - 2].y;
    const bx = points[i].x - points[i - 1].x;
    const by = points[i].y - points[i - 1].y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    angles.push(Math.atan2(cross, dot));
  }
  const angleChangeStd = std(angles);

  return {
    speedCV,
    accelerationCV,
    linearityScore: computeLinearity(points),
    angleChangeStd,
    autocorrelationLag1,
    efficiencyRatio,
    entropy: computeEntropy(angles),
  };
}

export function scoreMouse(f: MouseFeatures) {
  const tripped = {
    speedCV: f.speedCV < THRESHOLDS.speedCV,
    accelerationCV: f.accelerationCV < THRESHOLDS.accelerationCV,
    linearityScore: f.linearityScore > THRESHOLDS.linearityScore,
    angleChangeStd: f.angleChangeStd < THRESHOLDS.angleChangeStd,
    autocorrelationLag1: f.autocorrelationLag1 > THRESHOLDS.autocorrelationLag1,
    efficiencyRatio: f.efficiencyRatio > THRESHOLDS.efficiencyRatio,
    entropy: f.entropy < THRESHOLDS.entropy,
  };
  let totalScore = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    if (tripped[k]) totalScore += WEIGHTS[k];
  }
  return { tripped, totalScore, isAutomated: totalScore >= 0.6 };
}

// Deterministic PRNG so trajectory tests are reproducible (Math.random-free).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
