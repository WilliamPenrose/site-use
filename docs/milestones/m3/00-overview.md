# M3: "Reliably Run Long-Term"

> Upstream: [Milestone Overview](../overview.md) — M3
> Status: Group A complete (01-04 implemented) — Group B pending research spikes
> Prerequisite: M1 complete (all capabilities verified)

## Goal

Turn site-use from "works" to "works well". Users can run daily timeline collection without accumulating garbage tabs, missing auth checks, or getting opaque errors. When something fails, the AI client gets enough context to make recovery decisions.

## Capability Groups

| Group | Capabilities | Doc | Nature |
|-------|-------------|-----|--------|
| **A: Stability Core** | Tab reuse, Auth Guard middleware, Site-level rate limiting, Error handling enhancement | 01-04 | Scope confirmed |
| **B: Anti-Detection Enhancement** | Canvas noise, WebRTC leak protection, Ad/tracker blocking, Rate-limit signal detection | 05 | Requires research spike per item |

## Implementation Order

```
01 Tab Reuse → 02 Auth Guard → 03 Rate Limiting → 04 Error Handling → 05 Anti-Detection
```

Rationale:
- **01 Tab Reuse** first — all subsequent development and testing benefits from not accumulating duplicate tabs
- **02 Auth Guard** — depends on stable page management from 01
- **03 Rate Limiting** — independent module, but precedes error handling. Can throw a simple error initially; 04 enhances it
- **04 Error Handling** — broadest impact, placed last in Group A so earlier modules stabilize first
- **05 Anti-Detection** — independent of Group A, placed last. Each item requires a research spike before implementation

## Design Principle: Layered Responsibilities

M1 implementation naturally established a clean separation between throttle and backend layers. M3 respects and builds on this:

| Layer | Responsibility | M1 Status | M3 Enhancement |
|-------|---------------|-----------|----------------|
| **Throttle** (inter-operation) | Macro rhythm: delays between operations, global frequency caps | Random delay 1-3s | Site-level rate limiting (sliding window) + delay tuning |
| **Backend** (intra-operation) | Micro simulation: mouse trajectory, scroll stepping, click jitter | Bezier trajectory, humanized scroll, coordinate jitter | No changes needed (already complete) |

These two layers are orthogonal — throttle controls *when* operations happen, backend controls *how* each operation executes.

## Zero-Change Commitment to M1

- Primitives interface (`types.ts`) unchanged
- Throttle wrapping pattern unchanged (internal strategy enhancement only)
- MCP tool registration pattern unchanged
- Existing 3 error types (`ElementNotFound`, `SessionExpired`, `BrowserDisconnected`) signatures unchanged — only context fields extended
- Click enhancement (`click-enhanced.ts`) and scroll enhancement (`scroll-enhanced.ts`) unchanged

## Validation Scenarios

```
Scenario 1: Restart MCP server 3 times → Twitter tab count in Chrome does not grow
Scenario 2: Workflow runs while logged out → auto-detected, throws SessionExpired with hint
Scenario 3: High-frequency operations → rate limiter delays operations (no error thrown)
Scenario 4: Any error → context includes url + step + retryable + hint + screenshotBase64 (when browser is connected; BrowserDisconnected skips screenshot)
```

---

## Revision History

- 2026-03-22: Initial M3 detailed design created
  - Scope: 5 capability documents (4 confirmed + 1 research-dependent)
  - Key finding: M1 already implemented click jitter, Bezier trajectory, and progressive scrolling in backend layer; M3 throttle enhancement scoped down to site-level rate limiting only
  - Added tab reuse (overview issue #9) to M3 scope
  - Anti-detection capabilities (B group) separated as research-dependent items
- 2026-03-22: Group A implementation complete
  - All 4 capabilities (01-04) implemented, tested (195 unit tests), committed
  - Post-implementation cleanup: removed coordFix config (unconditional now); extracted site domains from puppeteer-backend to sites/twitter/site.ts
  - Group B (05 anti-detection) remains pending research spikes
