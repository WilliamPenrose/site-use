# Scroll Trajectory Detection in Diagnose

## Problem

The diagnose module can analyze mouse movement trajectories for humanness (via `trajectory-analyzer.ts`), but has no equivalent for scroll behavior. Real anti-bot systems (HUMAN/PerimeterX, DataDome, Akamai) analyze wheel event streams for mechanical patterns. We need a diagnose check that validates whether our `humanScroll` output looks human to these detection systems.

## Design

### 1. Refactor trajectory-analyzer into a generic framework

Currently `analyzeTrajectory()` is a monolithic function that runs all five mouse-specific checks. Refactor into a registry pattern where mouse and scroll each register their applicable checks.

**Shared interface:**

```ts
interface TrajectoryCheck {
  name: string;
  category: 'timing' | 'kinematics' | 'spatial';
  run(data: TrajectoryData): HumannessCheck;
}

interface TrajectoryData {
  // Common: timestamped 1D or 2D points
  points: TrajectoryPoint[];  // existing {x, y, timestamp}
  // Mouse-specific (optional)
  click?: TrajectoryPoint;
  target?: TargetGeometry;
  // Scroll-specific (optional)
  scrollDeltas?: ScrollDelta[];
}

interface ScrollDelta {
  deltaY: number;
  deltaX: number;
  deltaMode: number;
  timestamp: number;
}
```

**Check registration:**

| Check | Mouse | Scroll | Notes |
|-------|-------|--------|-------|
| Step timing CV | yes | yes | Universal — works on any timestamped sequence |
| Speed profile | yes | yes | Universal — bell-shaped velocity applies to scroll too |
| Curvature entropy | yes | dual-axis only | Skip for pure vertical scroll (angle is always ~0) |
| Fitts' Law | yes | no | Requires click target geometry |
| Landing accuracy | yes | no | Requires click target geometry |
| Delta uniformity | no | yes | CV of deltaY values; CV < 0.05 = bot |
| Pause pattern | no | yes | Absence of >300ms gaps = bot |
| Device mode match | no | yes | deltaY must match mouse (~100px) or trackpad (1-30px) patterns |

### 2. Scroll-specific checks

#### Delta uniformity (priority: high)

Coefficient of variation of `deltaY` values in the wheel event stream. Real devices produce variable deltas due to physical mechanics (mouse wheel notch inconsistency) or finger pressure (trackpad). Fixed-increment scrolling (e.g., every step exactly 60px) is a strong bot signal.

- Threshold: CV > 0.05
- Reference: libcaptcha/motion-attestation

#### Pause pattern (priority: high)

Whether the scroll stream contains natural pauses (>300ms gaps between wheel events). Human scrolling is reading-driven: scroll, pause to read, scroll again. Continuous uninterrupted scrolling is mechanical.

- Threshold: at least one gap > 300ms in a session > 1s
- Note: For single `humanScroll` calls (one continuous scroll), this check validates the inter-step timing has sufficient variance rather than requiring actual reading pauses. The pause pattern check is most meaningful at session level.
- For diagnose purposes: check that inter-event timing is not robotically uniform (overlaps with timing CV)

#### Device mode match (priority: high)

Check whether deltaY values match known device patterns:

- **Mouse wheel**: ~100-120px per notch, discrete, low frequency
- **Trackpad**: 1-30px per event, continuous, high frequency (60+ events/sec)
- **Neither**: arbitrary values like 60px/step = suspicious

The check infers device type from the delta distribution and reports whether it's consistent with a real input device.

- Threshold: deltaY median falls within mouse range (80-150) or trackpad range (1-40)
- Report: `{inferredDevice: 'mouse' | 'trackpad' | 'unknown', consistent: boolean}`

### 3. Diagnose integration

#### Browser side (page.ts)

Add a deferred scroll check, following the same pattern as `input-trusted` and `input-coords`:

- `setup()`: Register `wheel` event listener on `document`, collect `{deltaY, deltaX, deltaMode, timeStamp}` into an array
- `run()`: Return the collected data for analysis
- Expose via `window.__resolveScrollChecks()`

#### Runner side (runner.ts)

After existing mouse event triggers:

1. Trigger `humanScroll(page, 0, 600)` — scroll down ~600px
2. Read collected wheel events from the browser via `page.evaluate()`
3. Feed into the refactored analyzer's scroll checks
4. Inject results via `window.__addNodeResult()`

#### Diagnose HTML (index.html)

Add a spacer element (`min-height: 2000px`) so the page has enough content to scroll.

### 4. What we are NOT doing

- **Direction reversal detection**: Session-level behavior. A single `humanScroll` call is naturally unidirectional. Not meaningful for this scope.
- **clientX/clientY collection**: Mouse position during scroll is a secondary signal. Can be added later.
- **Multi-segment scrolling**: Keep runner simple with a single scroll trigger, matching the existing mouse check pattern.
- **Improving humanScroll itself**: Tracked separately. This spec is detection only.

## File changes

| File | Change |
|------|--------|
| `src/diagnose/trajectory-analyzer.ts` | Refactor into registry pattern with shared + domain-specific checks |
| `src/diagnose/checks/scroll-trajectory.ts` | New browser-side wheel event collector (setup/run pattern) |
| `src/diagnose/page.ts` | Wire up scroll check setup/resolve |
| `src/diagnose/runner.ts` | Add humanScroll trigger + scroll analysis step |
| `src/diagnose/index.html` | Add spacer for scrollable content |
| `tests/unit/trajectory-analyzer.test.ts` | Update for new API, add scroll check tests |
| `tests/integration/diagnose-runner.test.ts` | Add scroll check assertions |

## References

- Serwadda & Phoha 2013 — Step timing CV thresholds
- Flash & Hogan 1985 — Bell-shaped velocity profile
- libcaptcha/motion-attestation — Scroll detection weights and thresholds
- HUMAN/PerimeterX — Behavioral biometrics approach
- DataDome — Static vs dynamic behavior classification
