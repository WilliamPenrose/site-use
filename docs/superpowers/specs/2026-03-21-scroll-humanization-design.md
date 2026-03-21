# Scroll Humanization Design

> **Date**: 2026-03-21
> **Status**: Draft
> **Scope**: Humanize page scrolling and add scrollIntoView primitive

## Problem

The current `scroll()` implementation in `puppeteer-backend.ts` is mechanically detectable:
- Fixed 3 steps, fixed 80ms interval, equal deltaY per step, fixed 500ms post-wait.
- No step-size variation, no timing randomization.

Ghost-cursor provides a proven scroll humanization approach (scrollSpeed-based step sizing, smart scrollIntoView with fallback chain). Site-use adopts this step-sizing algorithm with two site-use-original enhancements: per-step size jitter (±10%) and randomized inter-step delays. Ghost-cursor fires steps with no jitter and no inter-step delay.

## Reference

- ghost-cursor `scroll()`: `src/spoof.ts:850-912` — scrollSpeed-based step sizing, CDP `Input.dispatchMouseEvent` type `mouseWheel`
- ghost-cursor `scrollIntoView()`: `src/spoof.ts:726-847` — viewport detection, delta calculation, 3-tier fallback
- site-use click-enhanced pattern: `src/primitives/click-enhanced.ts` — separate file for humanization logic, called by puppeteer-backend

## Design decisions

### `page.mouse.wheel()` vs CDP `Input.dispatchMouseEvent`

Ghost-cursor dispatches scroll events via CDP directly (`Input.dispatchMouseEvent` with `type: 'mouseWheel'`), which requires passing the current mouse cursor position (`x`, `y`). This makes the scroll event appear to originate from where the mouse is.

Site-use uses `page.mouse.wheel()` instead. Internally, Puppeteer's `mouse.wheel()` also calls CDP `Input.dispatchMouseEvent`, using its internally tracked cursor position. The practical difference is negligible for page-level scrolling (which doesn't depend on cursor position). The only scenario where cursor position matters is scrolling inside a specific `overflow: auto` container — not in scope for this design. Using the Puppeteer API keeps consistency with `clickWithTrajectory()` which also uses `page.mouse.move()` rather than CDP directly.

### Single config toggle

`ClickEnhancementConfig` has 5 granular toggles because each sub-feature (trajectory, coordFix, jitter, occlusionCheck, stabilityWait) is independently useful to disable for debugging. Scroll humanization sub-features (step jitter, timing randomization) are tightly coupled — disabling one without the other has no practical debugging value. A single `humanize` toggle is sufficient.

### Post-scroll delay: 200ms (down from 500ms)

The current 500ms post-scroll wait was conservative padding for lazy-loaded content. Ghost-cursor uses 200ms. The 200ms delay is sufficient for most scroll-triggered events; lazy-loading is handled by the caller (MCP tool or site workflow) which can add its own wait if needed.

## Design

### New file: `src/primitives/scroll-enhanced.ts`

Two exported functions:

#### `humanScroll(page, deltaX, deltaY, options?)`

Splits total scroll distance into multiple `page.mouse.wheel()` calls with humanized timing.

**Step sizing** (from ghost-cursor):
- Determine the larger axis (X or Y) and compute steps based on that
- `scrollSpeed` (internal param, default 60, range 1-100):
  - 1-89: step size = scrollSpeed pixels (e.g., 60 = 60px per step)
  - 90-100: exponential scale from 90px up to total distance (100 = single step)
- Shorter axis steps distributed proportionally, remainder added to last step

**Step jitter** (site-use original): each step's delta multiplied by `(0.9 + Math.random() * 0.2)` — ±10% variation. Remainder accumulated and added to last step to preserve total distance.

**Inter-step delay** (site-use original): base 20ms, randomized ±30% → effective range 14-26ms. No delay after the last step. Ghost-cursor has zero inter-step delay.

**Post-scroll delay**: 200ms default (configurable `scrollDelay`).

**Edge cases**:
- Zero distance (`deltaX === 0 && deltaY === 0`): no wheel calls, only post-scroll delay.
- Very large distance (>10000px): step count is naturally bounded by `distance / scrollSpeed`. At scrollSpeed=60, 10000px = ~167 steps — acceptable.

**Example**: 600px scroll at scrollSpeed=60 → ~10 steps, each ~60px (±6px jitter), ~20ms apart (±6ms), total ≈ 200ms movement + 200ms post-delay ≈ 400ms.

**Note on `deltaX`**: The public `ScrollOptions` only has `direction: 'up' | 'down'`, so `deltaX` is always 0 when called from `scroll()`. However, `scrollElementIntoView()` may compute non-zero `deltaX` when an element is horizontally off-screen. This is why `humanScroll` accepts both axes.

#### `scrollElementIntoView(page, backendNodeId, options?)`

Decision tree (not a linear fallback chain):

```
Is element in viewport (with margin)?
  └─ YES → return (no scroll)
  └─ NO → Is scrollSpeed === 100 AND inViewportMargin === 0?
            └─ YES → try CDP DOM.scrollIntoViewIfNeeded
            │           └─ success → return
            │           └─ fail → fall through to humanized scroll
            └─ NO → humanized scroll path
                      Calculate deltaX/deltaY, call humanScroll()
                        └─ fail → JS fallback: element.scrollIntoView({ block: 'center' })
```

**Viewport detection**: Get element bounding box via CDP `DOM.getBoxModel`, viewport dimensions via `window.innerWidth/innerHeight` (more reliable than `document.body.clientWidth` for pages with body overflow constraints).

**No stability wait**: Unlike `click()`, `scrollIntoView` does not need `waitForElementStable()`. The element is off-screen, so CSS animations in the viewport are irrelevant. The element's position only matters relative to the document, which is stable.

### Configuration: `src/config.ts`

```typescript
export interface ScrollEnhancementConfig {
  /** Enable humanized scrolling (step jitter + random delays). Default: true */
  humanize: boolean;
}

export function getScrollEnhancementConfig(): ScrollEnhancementConfig {
  return {
    humanize: envBool('SITE_USE_SCROLL_HUMANIZE', true),
  };
}
```

Single toggle. When disabled, `puppeteer-backend.ts` falls back to existing mechanical scroll (3 fixed steps, 80ms interval).

### Interface changes: `src/primitives/types.ts`

`ScrollOptions` — unchanged:
```typescript
export interface ScrollOptions {
  direction: 'up' | 'down';
  amount?: number; // default 600
}
```

`Primitives` interface — add:
```typescript
/** Scroll element into view if not already visible. */
scrollIntoView(uid: string, site?: string): Promise<void>;
```

### Integration: `src/primitives/puppeteer-backend.ts`

- `scroll()`: when `config.humanize` is true, delegate to `humanScroll()`; otherwise keep existing logic
- New `scrollIntoView(uid)`: same guard pattern as `click()` — check `uidToBackendNodeId` map size, throw `Error` if no snapshot, throw `ElementNotFound` if uid not found. Then delegate to `scrollElementIntoView()`.

### Throttle: `src/primitives/throttle.ts`

Add `scrollIntoView` entry to the returned object: `scrollIntoView: (uid, site?) => throttled(() => inner.scrollIntoView(uid, site))`. Same pattern as existing `scroll` and `click` entries.

## Internal parameters

These are NOT exposed to MCP callers. They live inside `scroll-enhanced.ts` as constants or function defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `scrollSpeed` | 60 | Pixels per step (1-89) or exponential scale (90-100) |
| `scrollDelay` | 200ms | Post-scroll delay |
| `stepDelayBase` | 20ms | Base inter-step delay (site-use original) |
| `stepDelayJitter` | 0.3 | ±30% randomization on step delay (site-use original) |
| `stepSizeJitter` | 0.1 | ±10% randomization on step size (site-use original) |
| `inViewportMargin` | 0 | Extra margin for viewport detection |

## Test plan

### Unit tests: `tests/unit/scroll-enhanced.test.ts`

Mock `page.mouse.wheel()` and CDP calls. Verify:

1. **Step count**: scrollSpeed=60, distance=600 → ~10 wheel calls
2. **Step jitter**: each wheel deltaY within ±10% of nominal step size
3. **Timing randomization**: inter-step delays are not all identical (measure via mock timers)
4. **scrollSpeed=100**: single wheel call (full distance)
5. **scrollSpeed=1**: many small steps (1px each)
6. **Zero distance**: deltaX=0, deltaY=0 → no wheel calls, only post-delay
7. **Negative delta**: deltaY < 0 (scroll up) → wheel calls with negative deltaY values
8. **scrollIntoView skip**: element already in viewport → no wheel calls
9. **scrollIntoView scroll**: element below viewport → humanScroll called with correct deltaY
10. **scrollIntoView horizontal**: element off-screen right → humanScroll called with non-zero deltaX
11. **scrollIntoView fallback**: CDP failure → JS scrollIntoView called
12. **Config off**: humanize=false → falls back to fixed 3-step scroll

## File changes

| File | Change |
|------|--------|
| `src/primitives/scroll-enhanced.ts` | **New** — humanScroll, scrollElementIntoView |
| `src/primitives/types.ts` | Add scrollIntoView to Primitives interface |
| `src/primitives/puppeteer-backend.ts` | scroll() delegates to humanScroll, new scrollIntoView() with uid guard pattern |
| `src/primitives/throttle.ts` | Add `scrollIntoView: (uid, site?) => throttled(() => inner.scrollIntoView(uid, site))` |
| `src/config.ts` | Add ScrollEnhancementConfig + getScrollEnhancementConfig() |
| `tests/unit/scroll-enhanced.test.ts` | **New** — unit tests |

## Out of scope

- Scroll trajectory analyzer (diagnostic tool) — future work
- Horizontal-only scroll API — current ScrollOptions only has up/down direction
- MCP tool registration for scrollIntoView — separate task after primitive is ready
