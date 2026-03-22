# Capability 02: Auth Guard Middleware

> Upstream: [M3 Overview](00-overview.md) — Group A
> Status: Design complete

## Problem

Login detection is currently an explicit `requireLogin()` call inside each workflow. Every workflow must remember to call it — if one forgets, authentication is not checked. As M2 adds 4 more workflows, the risk of omission grows.

---

## Goal

Change login detection from "workflow remembers to call" to "automatically happens". Workflow code should not need to know about auth checks.

---

## Design

### Architecture: Primitives Wrapping Layer

Same pattern as throttle — a wrapper between Primitives and workflow:

```
Sites layer → authGuard wrapper → throttle wrapper → PuppeteerBackend
```

`createAuthGuardedPrimitives(inner, configs)` wraps `navigate()`: when navigating to a protected site, it automatically checks login state. If not logged in, throws `SessionExpired`.

### Why Only Wrap navigate()

- Login state only needs checking **once when entering a site**, not on every click/scroll
- `navigate()` is every workflow's first step — the natural checkpoint
- Avoids unnecessary overhead on other operations

### Auth Guard Config

```typescript
interface AuthGuardConfig {
  site: string;
  domains: string[];
  check: (innerPrimitives: Primitives) => Promise<boolean>;
}
```

Twitter registration (defined at the **sites layer** or in `server.ts`, never inside `auth-guard.ts` — the check function is a callback, so `auth-guard.ts` has no import dependency on the sites layer):

```typescript
// Defined in server.ts or sites/twitter/ — NOT in primitives/auth-guard.ts
import { matchByRule, rules } from './sites/twitter/matchers.js';

const twitterAuthConfig: AuthGuardConfig = {
  site: 'twitter',
  domains: ['x.com', 'twitter.com'],
  check: async (inner) => {
    // inner is the throttled (but not auth-guarded) primitives.
    // This check goes through the throttle layer, adding one random delay
    // for the takeSnapshot call — acceptable overhead for a once-per-navigate check.
    const snapshot = await inner.takeSnapshot('twitter');
    return !!matchByRule(snapshot, rules.homeNavLink);
  },
};
```

### Avoiding Infinite Recursion

**Critical**: The auth guard's `check` function must use the **inner** (unwrapped) primitives. Otherwise:

```
authGuard.navigate() → check() → inner.navigate()  ← uses inner, no recursion
```

NOT:

```
authGuard.navigate() → check() → authGuard.navigate() → check() → ... ← infinite loop
```

The auth guard calls `inner.navigate(url, site)` first (bypassing itself), then runs the check function with `inner` primitives.

### Flow

```
authGuard.navigate(url, site)
  1. inner.navigate(url, site)              ← actual navigation, no guard
  2. Does URL domain match any protected site?
     → No  → return (transparent pass-through)
     → Yes → check(inner)
              → true  → return (logged in, proceed)
              → false → throw SessionExpired with hint
```

### Skipping the Guard

`checkLogin` workflow itself is a login detection tool — it must not be intercepted by the guard. Two approaches:

**Chosen approach**: `checkLogin` uses the **raw primitives** (before auth guard wrapping), not the guarded version. In `server.ts`, both `primitives` (guarded) and `rawPrimitives` (unguarded) are available. `checkLogin` receives `rawPrimitives`.

### Wrapping Chain in server.ts

```typescript
const backend = new PuppeteerBackend(browser);
const throttled = createThrottledPrimitives(backend);
// ... proxy auth on raw page (existing logic) ...
const guarded = createAuthGuardedPrimitives(throttled, [twitterAuthConfig]);

// Most tools use `guarded`
// checkLogin uses `throttled` (bypasses auth guard)
```

---

## Files Changed

| File | Change |
|------|--------|
| New: `src/primitives/auth-guard.ts` | Wrapper implementation |
| `src/server.ts` | Add auth guard to wrapping chain; pass raw primitives to checkLogin |
| `src/sites/twitter/workflows.ts` | Remove explicit `requireLogin()` call from `getTimeline` |

---

## Detection Logic Unchanged

The actual login check (URL inspection + ARIA element matching) is reused from M1's `checkLogin`. Only the trigger mechanism changes: manual → automatic.

---

## Validation

1. `getTimeline` when logged out → automatically throws `SessionExpired` (no explicit `requireLogin()` in workflow)
2. `checkLogin` works normally — not intercepted by guard
3. When logged in, guard passes transparently — no observable performance impact
4. Navigate to non-protected URL → guard does not trigger
