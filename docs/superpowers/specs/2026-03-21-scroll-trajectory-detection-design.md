# Scroll Trajectory Detection in Diagnose

## Problem

The diagnose module can analyze mouse movement trajectories for humanness (via `trajectory-analyzer.ts`), but has no equivalent for scroll behavior. Real anti-bot systems (HUMAN/PerimeterX, DataDome, Akamai) analyze wheel event streams for mechanical patterns. We need a diagnose check that validates whether our `humanScroll` output looks human to these detection systems.

## Design

### 1. Code organization: separate scroll analyzer, shared math utils

Keep the existing `analyzeTrajectory()` API untouched. Create a new `analyzeScrollTrajectory()` function in a separate file. Extract shared math helpers (`mean`, `stddev`, `pearsonR`) into a common utils module.

```
src/diagnose/
  trajectory-analyzer.ts   — mouse trajectory (unchanged API)
  scroll-analyzer.ts       — new: scroll trajectory analysis
  analyzer-utils.ts        — new: shared math (mean, stddev, pearsonR)
```

The two analyzers share the `HumannessCheck` and `HumannessReport` types, and reuse the same math utilities, but have independent entry points and check sets. No registry pattern — straightforward function calls.

### 2. Scroll-specific checks

#### Step timing CV (reused from mouse)

Coefficient of variation of inter-event time intervals. Identical logic to the mouse version, operating on the `timestamp` field of wheel events.

- Threshold: CV > 0.20
- Reference: Serwadda & Phoha 2013

#### Speed profile (reused from mouse, with caveat)

Bell-shaped velocity curve (acceleration then deceleration). Applied to the `|deltaY|` sequence as a proxy for instantaneous scroll speed.

- Threshold: score >= 0.50 (same criteria: peak in middle 60%, early/late averages below 50% of peak)
- Caveat: Flash & Hogan 1985 models point-to-point arm movements. Scroll may not always exhibit a clean bell shape. Threshold may need empirical calibration. For now, treat as a soft signal rather than a hard pass/fail.
- Reference: Flash & Hogan 1985

#### Delta uniformity (new, priority: high)

Coefficient of variation of `deltaY` values in the wheel event stream. Real devices produce variable deltas due to physical mechanics (mouse wheel notch inconsistency) or finger pressure (trackpad). Fixed-increment scrolling (e.g., every step exactly 60px) is a strong bot signal.

- Threshold: CV > 0.10
- Reference: libcaptcha/motion-attestation

#### Device mode match (new, priority: high)

Check whether deltaY values match known device patterns:

- **Mouse wheel**: 80-150px per notch, discrete, low frequency
- **Trackpad**: 1-50px per event, continuous, high frequency (60+ events/sec)

The check infers device type from the delta distribution and reports whether it's consistent with a real input device.

- Threshold: deltaY median falls within mouse range (80-150) or trackpad range (1-50)
- Values in neither range are flagged as suspicious
- Report: `{inferredDevice: 'mouse' | 'trackpad' | 'unknown', consistent: boolean}`

#### Curvature entropy (conditional)

Only enabled when both deltaX and deltaY are non-trivial (dual-axis scrolling). For pure vertical scroll (the common case), this check is skipped — angles between consecutive points would be ~0, producing meaningless entropy.

- Condition: at least 30% of events have `|deltaX| > 1`
- Same algorithm and threshold as mouse version when enabled

### 3. deltaMode normalization

`WheelEvent.deltaMode` affects the interpretation of delta values:
- `0` (PIXEL): values are in pixels — use as-is
- `1` (LINE): values are in lines — multiply by 16 (standard line height) to normalize to pixels
- `2` (PAGE): values are in pages — multiply by `window.innerHeight` to normalize to pixels

Normalization is applied in the browser-side collector before sending data to the analyzer. This ensures all threshold comparisons operate on pixel-scale values.

### 4. Diagnose integration

#### Browser side: new check file `src/diagnose/checks/scroll-deltas.ts`

Deferred check following the `input-trusted` / `input-coords` pattern:

```ts
interface ScrollDelta {
  deltaY: number;
  deltaX: number;
  timestamp: number;
}

// setup(): register wheel listener on document, normalize deltaMode,
//          push {deltaY, deltaX, timestamp} into array
// run(): return collected array (or empty if no events)
```

Exposed to the runner via `window.__scrollDeltas` (a getter, same pattern as `window.__allResults`).

#### Browser side: page.ts changes

- Import and call `setupScrollDeltas()` alongside existing `setupInputTrusted()` / `setupInputCoords()`
- Add `window.__resolveScrollChecks()` — called by runner after scroll trigger, runs the browser-side scroll check and adds its row

#### Runner side: runner.ts changes

After existing mouse event triggers (`page.mouse.move` + `page.mouse.click` + `__resolveInputChecks`):

1. Trigger `humanScroll(page, 0, 600)` — scroll down ~600px
2. Read collected wheel events: `const deltas = await page.evaluate(() => window.__scrollDeltas)`
3. Run `analyzeScrollTrajectory(deltas)` Node-side
4. Inject each check result via `page.evaluate(__addNodeResult, meta, result)` (same pattern as existing node checks)
5. Call `page.evaluate(() => window.__resolveScrollChecks())` for any browser-side scroll results

#### Diagnose HTML: index.html changes

Add a spacer div after the results table to ensure the page is scrollable:

```html
<div style="min-height: 2000px"></div>
```

This must be placed after the table but before the script tag. Existing checks (`window-size`, `visibility-state`, `document-focus`) operate on window/document properties unaffected by extra content height — no impact expected, but integration tests will verify.

### 5. What we are NOT doing

- **Pause pattern detection**: For a single `humanScroll` call (one continuous scroll), pause detection overlaps entirely with timing CV. Meaningful only at session level — deferred to future work.
- **Direction reversal detection**: Session-level behavior. A single `humanScroll` call is naturally unidirectional.
- **clientX/clientY collection**: Mouse position during scroll is a secondary signal. Can be added later.
- **Multi-segment scrolling**: Keep runner simple with a single scroll trigger.
- **Improving humanScroll itself**: Tracked separately (known issue: 60px step size doesn't match any real device). This spec is detection only.

## File changes

| File | Change |
|------|--------|
| `src/diagnose/analyzer-utils.ts` | New: extract `mean`, `stddev`, `pearsonR`, `dist` from trajectory-analyzer |
| `src/diagnose/trajectory-analyzer.ts` | Import math from analyzer-utils instead of inline definitions |
| `src/diagnose/scroll-analyzer.ts` | New: `analyzeScrollTrajectory()` with scroll-specific + shared checks |
| `src/diagnose/checks/scroll-deltas.ts` | New: browser-side wheel event collector (setup/run pattern) |
| `src/diagnose/page.ts` | Wire up scroll check setup/resolve |
| `src/diagnose/runner.ts` | Add humanScroll trigger + scroll analysis step |
| `src/diagnose/index.html` | Add spacer div for scrollable content |
| `tests/unit/scroll-analyzer.test.ts` | New: scroll analyzer unit tests |
| `tests/integration/diagnose-runner.test.ts` | Add scroll check assertions |

## References

- Serwadda & Phoha 2013 — Step timing CV thresholds
- Flash & Hogan 1985 — Bell-shaped velocity profile (caveat: arm movement model, not scroll-specific)
- libcaptcha/motion-attestation — Scroll detection weights and thresholds
- HUMAN/PerimeterX — Behavioral biometrics approach
- DataDome — Static vs dynamic behavior classification
