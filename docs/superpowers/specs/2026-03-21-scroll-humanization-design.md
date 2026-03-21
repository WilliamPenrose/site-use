# Scroll Humanization Design

> **Date**: 2026-03-21
> **Status**: Draft
> **Scope**: Humanize page scrolling and add scrollIntoView primitive

## Problem

The current `scroll()` implementation in `puppeteer-backend.ts` is mechanically detectable:
- Fixed 3 steps, fixed 80ms interval, equal deltaY per step, fixed 500ms post-wait.
- No step-size variation, no timing randomization.

Ghost-cursor provides a proven scroll humanization approach (scrollSpeed-based step sizing, CDP mouseWheel events, smart scrollIntoView with fallback chain). Site-use should adopt this pattern with micro-enhancements (step jitter, inter-step delay randomization).

## Reference

- ghost-cursor `scroll()`: `src/spoof.ts:850-912` — scrollSpeed-based step sizing, CDP mouseWheel dispatch
- ghost-cursor `scrollIntoView()`: `src/spoof.ts:726-847` — viewport detection, delta calculation, 3-tier fallback
- site-use click-enhanced pattern: `src/primitives/click-enhanced.ts` — separate file for humanization logic, called by puppeteer-backend

## Design

### New file: `src/primitives/scroll-enhanced.ts`

Two exported functions:

#### `humanScroll(page, deltaX, deltaY, options?)`

Splits total scroll distance into multiple `page.mouse.wheel()` calls with humanized timing.

**Step sizing** (ghost-cursor algorithm):
- Determine the larger axis (X or Y) and compute steps based on that
- `scrollSpeed` (internal param, default 60, range 1-100):
  - 1-89: step size = scrollSpeed pixels (e.g., 60 = 60px per step)
  - 90-100: exponential scale from 90px up to total distance (100 = single step)
- Shorter axis steps distributed proportionally, remainder added to last step

**Step jitter**: each step's deltaY (and deltaX) multiplied by `(0.9 + Math.random() * 0.2)` — ±10% variation.

**Inter-step delay**: base 20ms, randomized ±30% → effective range 14-26ms. No delay after the last step.

**Post-scroll delay**: configurable `scrollDelay`, default 200ms. Matches ghost-cursor default.

**Example**: 600px scroll at scrollSpeed=60 → ~10 steps, each ~60px (±6px jitter), ~20ms apart (±6ms), total ≈ 200ms movement + 200ms post-delay ≈ 400ms.

#### `scrollElementIntoView(page, backendNodeId, options?)`

Scrolls an element into view with 3-tier fallback:

1. **Viewport check**: Get element bounding box via CDP `DOM.getBoxModel`, get viewport dimensions via `page.evaluate()`. If element is within viewport (with configurable `inViewportMargin`, default 0), return immediately — no scroll needed.

2. **Humanized scroll**: Calculate deltaX/deltaY needed to bring element into view, call `humanScroll()`. This is the primary path for humanized behavior.

3. **CDP fast path**: When scrollSpeed=100 and inViewportMargin=0, use `DOM.scrollIntoViewIfNeeded` for instant scroll (no humanization needed at max speed).

4. **JS fallback**: If CDP calls fail, fall back to `element.scrollIntoView({ block: 'center', behavior: scrollSpeed < 90 ? 'smooth' : undefined })`.

### Configuration: `src/config.ts`

```typescript
export interface ScrollEnhancementConfig {
  /** Enable humanized scrolling (step jitter + random delays). Default: true */
  humanize: boolean;
}

// Environment variable: SITE_USE_SCROLL_HUMANIZE (default: true)
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
- New `scrollIntoView(uid)`: resolve uid to backendNodeId, delegate to `scrollElementIntoView()`

### Throttle: `src/primitives/throttle.ts`

Add `scrollIntoView` to the throttle wrapper, same pattern as existing `scroll`.

## Internal parameters

These are NOT exposed to MCP callers. They live inside `scroll-enhanced.ts` as constants or function defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `scrollSpeed` | 60 | Pixels per step (1-89) or exponential scale (90-100) |
| `scrollDelay` | 200ms | Post-scroll delay |
| `stepDelayBase` | 20ms | Base inter-step delay |
| `stepDelayJitter` | 0.3 | ±30% randomization on step delay |
| `stepSizeJitter` | 0.1 | ±10% randomization on step size |
| `inViewportMargin` | 0 | Extra margin for viewport detection |

## Test plan

### Unit tests: `tests/unit/scroll-enhanced.test.ts`

Mock `page.mouse.wheel()` and CDP calls. Verify:

1. **Step count**: scrollSpeed=60, distance=600 → ~10 wheel calls
2. **Step jitter**: each wheel deltaY within ±10% of nominal step size
3. **Timing randomization**: inter-step delays are not all identical (measure via mock timers)
4. **scrollSpeed=100**: single wheel call (full distance)
5. **scrollSpeed=1**: many small steps (1px each)
6. **scrollIntoView skip**: element already in viewport → no wheel calls
7. **scrollIntoView scroll**: element below viewport → humanScroll called with correct deltaY
8. **scrollIntoView fallback**: CDP failure → JS scrollIntoView called
9. **Config off**: humanize=false → falls back to fixed 3-step scroll

## File changes

| File | Change |
|------|--------|
| `src/primitives/scroll-enhanced.ts` | **New** — humanScroll, scrollElementIntoView |
| `src/primitives/types.ts` | Add scrollIntoView to Primitives interface |
| `src/primitives/puppeteer-backend.ts` | scroll() delegates to humanScroll, new scrollIntoView() |
| `src/primitives/throttle.ts` | Add scrollIntoView throttle wrapper |
| `src/config.ts` | Add ScrollEnhancementConfig |
| `tests/unit/scroll-enhanced.test.ts` | **New** — unit tests |

## Out of scope

- Scroll trajectory analyzer (diagnostic tool) — future work
- Horizontal-only scroll API — current ScrollOptions only has up/down direction
- MCP tool registration for scrollIntoView — separate task after primitive is ready
