# Capability 04: Error Handling Enhancement

> Upstream: [M3 Overview](00-overview.md) — Group A
> Status: Complete (2026-03-22, commits 9996c63 + fecf2d6 + 831293b)

## Context

M1 has 3 error types with basic context (`url` + `message`). `formatToolError` in `server.ts` serializes errors as JSON for the AI client, but provides limited information — the AI knows *that* something failed, but not *what was happening*, *what the page looked like*, or *what to do next*.

---

## Goal

1. Add 2 new error types (`RateLimited`, `NavigationFailed`)
2. All errors carry full context (operation step + page URL + auto-screenshot)
3. Add `retryable` field — guides AI on whether to retry
4. Add `hint` field — suggests next action to the AI

---

## Design

### Enhanced ErrorContext

`ErrorContext` already has `url`, `step`, `snapshotSummary`, and `screenshotBase64` fields defined in M1. Some throw sites (e.g., `click`, `scrollIntoView`) already populate `step`. M3 adds two new fields and ensures all existing fields are consistently populated:

```typescript
interface ErrorContext {
  url?: string;
  step?: string;                // existing — ensure ALL throw sites populate this
  snapshotSummary?: string;     // existing — accessibility tree summary
  screenshotBase64?: string;    // existing but never filled — M3 auto-populates on error
  retryable?: boolean;          // NEW — should AI retry this operation?
  hint?: string;                // NEW — suggested next action for AI
}
```

### New Error Types

| Error | Trigger | retryable | hint |
|-------|---------|-----------|------|
| `RateLimited` | 05 anti-detection detects 429 / captcha page (B4 research spike). Type is defined in 04 regardless of B4 outcome — available for future use even if B4 is deferred. | `false` | `"Twitter is rate-limiting requests. Wait at least 15 minutes before retrying."` |
| `NavigationFailed` | Page load timeout, network error. For transient failures (timeout, 5xx): `retryable: true`. For permanent failures (4xx): `retryable: false`. | varies | Transient: `"Network error or timeout. Wait a few seconds and retry."` Permanent: `"Page not found or access denied. Check the URL and try a different approach."` |

### Existing Error Retryable Classification

| Error | retryable | hint | Rationale |
|-------|-----------|------|-----------|
| `ElementNotFound` | `true` | `"The page may still be loading. Try taking a screenshot to check page state, then retry."` | Page might still be loading; re-snapshot may find element |
| `SessionExpired` | `false` | `"Ask the user to log in manually in the Chrome window, then retry."` | Requires human intervention |
| `BrowserDisconnected` | `true` | `"Chrome has closed. The next tool call will automatically relaunch it."` | Server auto-reconnects Chrome |

### Auto-Screenshot on Error

Errors are enriched with a screenshot at the MCP tool layer (`formatToolError`):

```
formatToolError(err, primitives?)
  → if primitives available AND browser connected
    → try screenshot()
    → success → fill context.screenshotBase64
    → failure → skip silently (don't mask original error)
  → BrowserDisconnected → skip screenshot (browser is gone)
```

#### Why Only at the MCP Layer

- Single capture point — no scattered screenshot calls in Primitives or workflows
- Primitives and workflows throw errors; the MCP layer catches and enriches them
- Screenshot is for AI client consumption; lower layers don't need it

#### Screenshot Failure Handling

- Screenshot itself may fail (browser just disconnected, tab crashed)
- On failure: log warning to stderr, proceed without screenshot
- Never throw a new error that masks the original

### step Field Population

Error throw sites are updated to include `step`:

| Layer | step value examples |
|-------|-------------------|
| PuppeteerBackend | `"click"`, `"navigate"`, `"takeSnapshot"`, `"scroll"` |
| Twitter workflows | `"checkLogin"`, `"getTimeline"`, `"collectTweets"` |
| Auth Guard | `"authGuard"` |
| Rate Limiter (B4) | `"rateLimitDetection"` |

Workflow-level `step` overwrites Primitive-level `step` — the AI cares more about "what business operation failed" than "which CDP call broke".

### formatToolError Signature Change

```typescript
// M1: only accepts error
export function formatToolError(err: unknown): ToolResult

// M3: accepts primitives for screenshot capture
export function formatToolError(err: unknown, primitives?: Primitives): ToolResult
```

MCP tool handlers pass primitives:

```typescript
} catch (err) {
  return formatToolError(err, primitives);
}
```

### Output Example

Before (M1):
```json
{
  "type": "SessionExpired",
  "message": "Twitter login required",
  "context": { "url": "https://x.com/home" }
}
```

After (M3):
```json
{
  "type": "SessionExpired",
  "message": "Twitter login required",
  "context": {
    "url": "https://x.com/i/flow/login",
    "step": "authGuard",
    "retryable": false,
    "hint": "Ask the user to log in manually in the Chrome window, then retry.",
    "screenshotBase64": "iVBORw0KGgo..."
  }
}
```

---

## Design Philosophy

**Detect, classify, throw — never recover.** Recovery belongs to the caller (AI), which has user context and conversational ability. site-use provides:

- **retryable**: whether retry is worth attempting
- **hint**: what the AI should do (suggest, not enforce)
- **screenshot**: what the page looks like (AI can "see" the problem)

---

## Files Changed

| File | Change |
|------|--------|
| `src/errors.ts` | Add `RateLimited`, `NavigationFailed` classes; add `retryable` and `hint` to `ErrorContext` |
| `src/server.ts` | `formatToolError` gains `primitives` parameter; auto-screenshot logic |
| `src/primitives/puppeteer-backend.ts` | Ensure all throw sites populate `step` (some already do — `click`, `scrollIntoView`) |
| `src/sites/twitter/workflows.ts` | Ensure all throw sites populate `step` |
| `src/primitives/auth-guard.ts` | Throw `SessionExpired` with `step: "authGuard"` and `hint` |

---

## Validation

1. Any error → context includes `url` + `step` + `retryable` + `hint`
2. Non-BrowserDisconnected error → context includes `screenshotBase64`
3. BrowserDisconnected → no screenshot, no secondary error
4. AI receives `retryable: false` → should stop and communicate with user
5. AI receives `retryable: true` → can retry the operation
