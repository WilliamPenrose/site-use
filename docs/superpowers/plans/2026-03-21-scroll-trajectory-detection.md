# Scroll Trajectory Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scroll humanness detection to the diagnose module, so `--diagnose` validates whether `humanScroll` output looks human to anti-bot detection systems.

**Architecture:** Extract shared math utils from `trajectory-analyzer.ts`, create a new `scroll-analyzer.ts` with scroll-specific checks (delta uniformity, device mode match) plus reused checks (timing CV, speed profile). Add a browser-side wheel event collector and wire it into the diagnose runner. The existing mouse trajectory analyzer API remains unchanged.

**Tech Stack:** TypeScript, Vitest, Puppeteer CDP (wheel events), esbuild (browser bundle)

**Spec:** `docs/superpowers/specs/2026-03-21-scroll-trajectory-detection-design.md`

---

### Task 1: Extract shared math utils

**Files:**
- Create: `src/diagnose/analyzer-utils.ts`
- Modify: `src/diagnose/trajectory-analyzer.ts:44-77`

- [ ] **Step 1: Create `analyzer-utils.ts` with math functions**

```ts
// src/diagnose/analyzer-utils.ts

/**
 * Shared math utilities for trajectory and scroll analyzers.
 */

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

export function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
```

- [ ] **Step 2: Update `trajectory-analyzer.ts` to import from utils**

Replace the inline `mean`, `stddev`, `pearsonR` definitions (lines 44-73) with:

```ts
import { mean, stddev, pearsonR } from './analyzer-utils.js';
```

Keep the `dist` function inline — it's specific to 2D trajectory points and not needed by scroll.

- [ ] **Step 3: Build and run existing tests to verify no regression**

Run: `pnpm run build && pnpm test`
Expected: All existing tests pass. The refactor is purely mechanical — same functions, different location.

- [ ] **Step 4: Commit**

```bash
git add src/diagnose/analyzer-utils.ts src/diagnose/trajectory-analyzer.ts
git commit -m "refactor(diagnose): extract shared math utils from trajectory-analyzer"
```

---

### Task 2: Create scroll analyzer with unit tests

**Files:**
- Create: `src/diagnose/scroll-analyzer.ts`
- Create: `tests/unit/scroll-analyzer.test.ts`

- [ ] **Step 1: Write failing tests for scroll analyzer**

```ts
// tests/unit/scroll-analyzer.test.ts
import { describe, it, expect } from 'vitest';
import type { ScrollDelta } from '../../src/diagnose/scroll-analyzer.js';
import { analyzeScrollTrajectory } from '../../src/diagnose/scroll-analyzer.js';

function makeUniformDeltas(count: number, deltaY: number, intervalMs: number): ScrollDelta[] {
  return Array.from({ length: count }, (_, i) => ({
    deltaY,
    deltaX: 0,
    timestamp: i * intervalMs,
  }));
}

function makeHumanLikeDeltas(): ScrollDelta[] {
  // Simulate mouse wheel: ~100px deltas with ±15% variance,
  // timing intervals ~80ms with ±40% variance
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
      // median ~100 falls in mouse range 80-150
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
      // median ~10 falls in trackpad range 1-50
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
      // At least device mode match should pass for ~100px deltas
      const device = report.checks.find(c => c.name === 'Device mode match');
      expect(device?.pass).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && npx vitest run tests/unit/scroll-analyzer.test.ts`
Expected: FAIL — module `scroll-analyzer.js` does not exist

- [ ] **Step 3: Implement `scroll-analyzer.ts`**

```ts
// src/diagnose/scroll-analyzer.ts

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

  // Smooth with window of 3
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

  // Peak in middle 60%
  const peakRatio = peakIndex / (n - 1);
  if (peakRatio >= 0.20 && peakRatio <= 0.80) score++;

  // Early 20% below 50% of peak
  const earlyEnd = Math.max(1, Math.floor(n * 0.20));
  if (mean(smoothed.slice(0, earlyEnd)) < peakValue * 0.50) score++;

  // Late 20% below 50% of peak
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

/**
 * CV of deltaY values. Real devices produce variable deltas.
 * Fixed-increment scrolling (CV < 0.10) is a bot signal.
 *
 * Reference: libcaptcha/motion-attestation
 */
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

/**
 * Infer device type from deltaY distribution.
 * Mouse wheel: 80-150px per notch. Trackpad: 1-50px per event.
 * Values outside both ranges are suspicious.
 */
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
    // Extra info for diagnostics — stored in the standard `actual` field
    // when consumed via the diagnose check wrapper
  } as HumannessCheck & { device: string };
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

  // Device mode match — report device type in the check result
  const deviceCheck = checkDeviceModeMatch(deltas);
  checks.push(deviceCheck);

  // Curvature entropy — only for dual-axis scrolling
  if (hasDualAxis(deltas)) {
    checks.push(checkCurvatureEntropy(deltas));
  }

  const passCount = checks.filter(c => c.pass).length;
  const overallScore = checks.length > 0 ? passCount / checks.length : 0;

  return { checks, overallScore };
}
```

- [ ] **Step 4: Build and run scroll analyzer tests**

Run: `pnpm run build && npx vitest run tests/unit/scroll-analyzer.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/diagnose/scroll-analyzer.ts tests/unit/scroll-analyzer.test.ts
git commit -m "feat(diagnose): add scroll trajectory humanness analyzer"
```

---

### Task 3: Add browser-side wheel event collector

**Files:**
- Create: `src/diagnose/checks/scroll-deltas.ts`
- Modify: `src/diagnose/page.ts`

- [ ] **Step 1: Create `scroll-deltas.ts` — wheel event collector**

This follows the `input-trusted.ts` / `input-coords.ts` deferred check pattern: `setup()` registers listeners, `run()` returns collected data.

```ts
// src/diagnose/checks/scroll-deltas.ts
import type { CheckMeta, CheckResult } from '../types.js';

export const meta: CheckMeta & { runtime: 'browser' } = {
  id: 'scroll-deltas',
  name: 'Scroll event collection',
  description: 'Collect wheel events for scroll trajectory analysis',
  runtime: 'browser',
  expected: 'events collected',
  info: true,
};

interface CollectedDelta {
  deltaY: number;
  deltaX: number;
  timestamp: number;
}

const collected: CollectedDelta[] = [];

const LINE_HEIGHT = 16;

export function setup(): void {
  document.addEventListener('wheel', (e: WheelEvent) => {
    // Normalize deltaMode to pixels
    let deltaY = e.deltaY;
    let deltaX = e.deltaX;
    if (e.deltaMode === 1) {
      // LINE mode
      deltaY *= LINE_HEIGHT;
      deltaX *= LINE_HEIGHT;
    } else if (e.deltaMode === 2) {
      // PAGE mode
      deltaY *= window.innerHeight;
      deltaX *= window.innerWidth;
    }
    collected.push({ deltaY, deltaX, timestamp: e.timeStamp });
  }, { passive: true });
}

export function run(): CheckResult {
  if (collected.length === 0) {
    return { pass: true, actual: 'no wheel events (skipped)' };
  }
  return {
    pass: true,
    actual: `${collected.length} events collected`,
  };
}

/** Expose collected deltas for Node runner to read */
export function getDeltas(): CollectedDelta[] {
  return collected;
}
```

- [ ] **Step 2: Wire up in `page.ts`**

Add imports at the top of `page.ts`, alongside existing input check imports:

```ts
import { setup as setupScrollDeltas, run as runScrollDeltas, meta as scrollDeltasMeta, getDeltas as getScrollDeltas } from './checks/scroll-deltas.js';
```

In `runAll()`, add `setupScrollDeltas()` alongside the existing setup calls:

```ts
setupInputTrusted();
setupInputCoords();
setupScrollDeltas();
```

Add a new window API for the runner, after the existing `__resolveInputChecks`:

```ts
/** Called after Node triggers scroll events to resolve scroll checks */
(window as unknown as Record<string, () => void>).__resolveScrollChecks = () => {
  addRow(scrollDeltasMeta, runScrollDeltas());
  updateStatus();
};

/** Expose collected scroll deltas for Node runner */
Object.defineProperty(window, '__scrollDeltas', {
  get: () => getScrollDeltas(),
  configurable: true,
});
```

- [ ] **Step 3: Add `scroll-deltas.ts` to barrel exclude list in `build.mjs`**

`scroll-deltas.ts` is a deferred check (same as `input-trusted.ts` and `input-coords.ts`) — it must NOT be auto-included in the barrel. In `scripts/build.mjs`, update the `excludeFiles` set (line 33):

```js
const excludeFiles = new Set(['input-trusted.ts', 'input-coords.ts', 'scroll-deltas.ts']);
```

- [ ] **Step 4: Build to verify compilation**

Run: `pnpm run build`
Expected: Build succeeds, no errors

- [ ] **Step 5: Commit**

```bash
git add src/diagnose/checks/scroll-deltas.ts src/diagnose/page.ts scripts/build.mjs
git commit -m "feat(diagnose): add browser-side wheel event collector for scroll analysis"
```

---

### Task 4: Add scrollable content to diagnose page

**Files:**
- Modify: `src/diagnose/index.html`

- [ ] **Step 1: Add spacer div to `index.html`**

Add after the `<div id="status">` line and before the `<script>` tag:

```html
  <div style="min-height: 2000px" aria-hidden="true"></div>
```

- [ ] **Step 2: Build and run existing integration tests**

Run: `pnpm run build && npx vitest run tests/integration/diagnose-runner.test.ts`
Expected: All existing tests still pass — the spacer only adds height, doesn't affect check logic.

- [ ] **Step 3: Commit**

```bash
git add src/diagnose/index.html
git commit -m "feat(diagnose): add spacer to diagnose page for scroll testing"
```

---

### Task 5: Wire scroll analysis into the diagnose runner

**Files:**
- Modify: `src/diagnose/runner.ts`

- [ ] **Step 1: Add imports to `runner.ts`**

```ts
import { humanScroll } from '../primitives/scroll-enhanced.js';
import { analyzeScrollTrajectory } from './scroll-analyzer.js';
import type { ScrollDelta } from './scroll-analyzer.js';
```

- [ ] **Step 2: Add scroll trigger and analysis after mouse input checks**

After the `__resolveInputChecks` evaluate block (lines 44-46) and before the node-side checks loop (`for (const entry of nodeChecks)` at line 49), add:

```ts
    // Trigger scroll events for scroll checks
    await humanScroll(page, 0, 600);

    // Read collected wheel deltas from browser
    const scrollDeltas = await page.evaluate(() => {
      return (window as unknown as Record<string, unknown>).__scrollDeltas as Array<{
        deltaY: number;
        deltaX: number;
        timestamp: number;
      }>;
    });

    // Run scroll trajectory analysis (Node-side)
    if (scrollDeltas && scrollDeltas.length >= 3) {
      const scrollReport = analyzeScrollTrajectory(scrollDeltas);
      for (const check of scrollReport.checks) {
        const checkMeta = {
          id: `scroll-${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name: `Scroll: ${check.name}`,
          description: check.reference,
          runtime: 'node' as const,
          expected: check.threshold.min != null
            ? `>${check.threshold.min}`
            : `<${check.threshold.max}`,
        };
        const checkResult = {
          pass: check.pass,
          actual: String(check.value.toFixed(3)),
          detail: check.reference,
        };
        await page.evaluate(
          (meta, res) => {
            (
              window as unknown as Record<
                string,
                (m: typeof meta, r: typeof res) => void
              >
            ).__addNodeResult(meta, res);
          },
          { ...checkMeta } as Record<string, unknown>,
          { ...checkResult } as Record<string, unknown>,
        );
      }
    }

    // Resolve browser-side scroll info check
    await page.evaluate(() => {
      (window as unknown as Record<string, () => void>).__resolveScrollChecks();
    });
```

- [ ] **Step 3: Build and run integration tests**

Run: `pnpm run build && npx vitest run tests/integration/diagnose-runner.test.ts`
Expected: Existing tests pass (they only assert `length > 10` and specific IDs, the new checks add to the total).

- [ ] **Step 4: Commit**

```bash
git add src/diagnose/runner.ts
git commit -m "feat(diagnose): wire scroll trajectory analysis into diagnose runner"
```

---

### Task 6: Add integration test assertions for scroll checks

**Files:**
- Modify: `tests/integration/diagnose-runner.test.ts`

- [ ] **Step 1: Add scroll check assertions**

Add a new test inside the existing `describe('diagnose runner', ...)` block:

```ts
  it('includes scroll trajectory analysis results', () => {
    const scrollChecks = cachedResults.filter((r) => r.meta.id.startsWith('scroll-'));
    // At minimum: timing CV, speed profile, delta uniformity, device mode match
    expect(scrollChecks.length).toBeGreaterThanOrEqual(4);
    for (const sc of scrollChecks) {
      expect(sc.result).toHaveProperty('pass');
      expect(sc.result).toHaveProperty('actual');
    }
  });

  it('includes scroll event collection info', () => {
    const collector = cachedResults.find((r) => r.meta.id === 'scroll-deltas');
    expect(collector).toBeDefined();
    expect(collector!.result.actual).toMatch(/\d+ events collected/);
  });
```

- [ ] **Step 2: Build and run integration tests**

Run: `pnpm run build && npx vitest run tests/integration/diagnose-runner.test.ts`
Expected: All tests pass, including new scroll assertions.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/diagnose-runner.test.ts
git commit -m "test(diagnose): add integration test assertions for scroll trajectory checks"
```

---

### Task 7: Full build and test verification

- [ ] **Step 1: Clean build and full test suite**

Run: `pnpm run build && pnpm test`
Expected: All tests pass (unit + integration).

- [ ] **Step 2: Manual smoke test with `--diagnose`**

Run: `node dist/index.js --diagnose`
Expected: Output includes scroll check results:
```
  [PASS] Scroll: Step timing CV              expected=>0.20  actual=...
  [PASS] Scroll: Speed profile               expected=>0.50  actual=...
  [FAIL] Scroll: Delta uniformity            expected=>0.10  actual=...
  [FAIL] Scroll: Device mode match           expected=>1-150 actual=...
  [INFO] Scroll event collection             expected=events collected  actual=N events collected
```

Note: `Delta uniformity` and `Device mode match` are expected to FAIL with the current `humanScroll` implementation (60px fixed steps). This is correct — it validates that our detection works. Fixing `humanScroll` is tracked separately.

- [ ] **Step 3: Final commit if any fixes were needed**

Only if previous steps required adjustments.
