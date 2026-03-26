# Plan 2: Runtime — Per-Site Isolation and Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-site runtime isolation layer — each site gets its own tab, mutex, rate limiter, circuit breaker, and primitives stack, managed by a central SiteRuntimeManager.

**Architecture:** New `src/runtime/` module. Circuit breaker is extracted from server.ts's inline counter into a standalone class. SiteRuntimeManager lazily creates SiteRuntime instances per site, each with its own Chrome tab and full primitives stack. Browser is shared; everything else is per-site.

**Tech Stack:** TypeScript, Vitest, Puppeteer

**Spec:** [M8 Multi-Site Plugin Architecture](./multi-site-plugin-architecture.md) — Section 3

**Depends on:** Plan 1 (registry types)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/runtime/types.ts` | SiteRuntime interface |
| Create | `src/runtime/circuit-breaker.ts` | Per-site circuit breaker (extracted from server.ts inline logic) |
| Create | `src/runtime/build-site-stack.ts` | Build a full primitives stack for one site on one page |
| Create | `src/runtime/manager.ts` | SiteRuntimeManager — lazy create, cache, destroy per-site runtimes |
| Create | `src/runtime/index.ts` | Public API re-export |
| Create | `tests/unit/circuit-breaker.test.ts` | Circuit breaker tests |
| Create | `tests/unit/runtime-manager.test.ts` | Manager lifecycle tests |
| Modify | `src/primitives/types.ts` | Remove `site?` param from Primitives interface |
| Modify | `src/primitives/puppeteer-backend.ts` | Remove `site?` param from backend methods |
| Modify | `src/primitives/throttle.ts` | Remove `site?` param passthrough |
| Modify | `src/primitives/auth-guard.ts` | Remove `site?` param passthrough |

---

### Task 1: SiteRuntime type definition

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/index.ts`

- [ ] **Step 1: Create `src/runtime/types.ts`**

```ts
import type { Primitives } from '../primitives/types.js';
import type { SitePlugin } from '../registry/types.js';
import type { Mutex } from '../mutex.js';
import type { Page } from 'puppeteer-core';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RateLimitDetector } from '../primitives/rate-limit-detect.js';

/** Per-site auth state — tracks last known login status. */
export interface AuthState {
  /** Whether the user was logged in at last check. null = never checked. */
  loggedIn: boolean | null;
  /** Timestamp of last auth check (ms since epoch). */
  lastCheckedAt: number | null;
}

export interface SiteRuntime {
  /** The plugin declaration this runtime was created from. */
  plugin: SitePlugin;
  /** Per-site primitives stack (throttle + auth guard + rate-limit detect). */
  primitives: Primitives;
  /** Dedicated Chrome tab for this site. */
  page: Page;
  /** Per-site operation lock — serializes operations within this site. */
  mutex: Mutex;
  /** Per-site circuit breaker — trips after consecutive errors on this site. */
  circuitBreaker: CircuitBreaker;
  /** Per-site rate limit detector — accessible for diagnostics/stats. */
  rateLimitDetector: RateLimitDetector;
  /** Per-site auth state — cached login status. */
  authState: AuthState;
}
```

- [ ] **Step 2: Create `src/runtime/index.ts`**

```ts
export type { SiteRuntime } from './types.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { SiteRuntimeManager } from './manager.js';
```

Note: this file will fail to compile until Tasks 2 and 4 create the imported modules. That's expected — we build bottom-up.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/types.ts src/runtime/index.ts
git commit -m "feat(runtime): define SiteRuntime type"
```

---

### Task 2: Three-state circuit breaker

**Files:**
- Create: `src/runtime/circuit-breaker.ts`
- Create: `tests/unit/circuit-breaker.test.ts`

Three-state model (closed → open → half-open → closed) replaces the simple counter. Open state blocks requests for `cooldownMs`, then half-open allows one probe. Probe success → closed; probe failure → back to open.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/circuit-breaker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ── closed state ───────────────────────────────────────────
  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('closed');
    expect(cb.isTripped).toBe(false);
  });

  it('stays closed below threshold', () => {
    const cb = new CircuitBreaker(5);
    for (let i = 0; i < 4; i++) cb.recordError();
    expect(cb.state).toBe('closed');
    expect(cb.isTripped).toBe(false);
  });

  it('resets streak on success in closed state', () => {
    const cb = new CircuitBreaker(5);
    cb.recordError();
    cb.recordError();
    cb.recordError();
    cb.recordSuccess();
    expect(cb.streak).toBe(0);
    expect(cb.state).toBe('closed');
  });

  // ── closed → open transition ───────────────────────────────
  it('transitions to open at threshold', () => {
    const cb = new CircuitBreaker(5);
    for (let i = 0; i < 5; i++) cb.recordError();
    expect(cb.state).toBe('open');
    expect(cb.isTripped).toBe(true);
  });

  it('blocks requests while open (within cooldown)', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(30_000); // 30s < 60s cooldown
    expect(cb.isTripped).toBe(true);
    expect(cb.state).toBe('open');
  });

  // ── open → half-open transition ────────────────────────────
  it('transitions to half-open after cooldown expires', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.state).toBe('open');
    vi.advanceTimersByTime(60_001);
    expect(cb.isTripped).toBe(false); // allows one probe
    expect(cb.state).toBe('half-open');
  });

  // ── half-open → closed (probe success) ─────────────────────
  it('transitions to closed on success in half-open', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    vi.advanceTimersByTime(60_001);
    expect(cb.state).toBe('half-open');
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.streak).toBe(0);
    expect(cb.isTripped).toBe(false);
  });

  // ── half-open → open (probe failure) ───────────────────────
  it('transitions back to open on error in half-open', () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) cb.recordError();
    vi.advanceTimersByTime(60_001);
    expect(cb.state).toBe('half-open');
    cb.recordError();
    expect(cb.state).toBe('open');
    expect(cb.isTripped).toBe(true);
    // Cooldown restarts from now
    vi.advanceTimersByTime(59_999);
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cb.isTripped).toBe(false); // half-open again
  });

  // ── reset ──────────────────────────────────────────────────
  it('reset() returns to closed regardless of state', () => {
    const cb = new CircuitBreaker(3);
    for (let i = 0; i < 3; i++) cb.recordError();
    expect(cb.state).toBe('open');
    cb.reset();
    expect(cb.state).toBe('closed');
    expect(cb.streak).toBe(0);
  });

  // ── defaults ───────────────────────────────────────────────
  it('uses default threshold of 5 and cooldown of 60s', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordError();
    expect(cb.state).toBe('open');
    vi.advanceTimersByTime(59_999);
    expect(cb.isTripped).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cb.isTripped).toBe(false);
  });

  it('exposes current streak count', () => {
    const cb = new CircuitBreaker(3);
    expect(cb.streak).toBe(0);
    cb.recordError();
    expect(cb.streak).toBe(1);
    cb.recordError();
    expect(cb.streak).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/circuit-breaker.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement three-state CircuitBreaker**

```ts
// src/runtime/circuit-breaker.ts

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/**
 * Per-site three-state circuit breaker.
 *
 * - closed:    normal operation, counting consecutive errors
 * - open:      tripped, rejecting all requests for cooldownMs
 * - half-open: cooldown expired, allowing one probe request
 *
 * Transitions:
 *   closed  + threshold errors  → open
 *   open    + cooldown expires  → half-open (checked lazily via isTripped)
 *   half-open + success         → closed
 *   half-open + error           → open (cooldown restarts)
 */
export class CircuitBreaker {
  private errorCount = 0;
  private _state: CircuitBreakerState = 'closed';
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold = 5, cooldownMs = 60_000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get state(): CircuitBreakerState {
    // Lazy transition: open → half-open when cooldown expires
    if (this._state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this._state = 'half-open';
    }
    return this._state;
  }

  /** Whether requests should be blocked. */
  get isTripped(): boolean {
    return this.state === 'open';
  }

  /** Current consecutive error count. */
  get streak(): number {
    return this.errorCount;
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    if (this._state === 'half-open') {
      // Probe succeeded — fully recover
      this._state = 'closed';
    }
    this.errorCount = 0;
  }

  /** Record a failed operation. */
  recordError(): void {
    if (this._state === 'half-open') {
      // Probe failed — back to open, restart cooldown
      this._state = 'open';
      this.openedAt = Date.now();
      return;
    }
    this.errorCount++;
    if (this.errorCount >= this.threshold) {
      this._state = 'open';
      this.openedAt = Date.now();
    }
  }

  /** Force reset to closed state. */
  reset(): void {
    this._state = 'closed';
    this.errorCount = 0;
    this.openedAt = 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/circuit-breaker.test.ts`
Expected: all 12 tests PASS

- [ ] **Step 5: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 6: Commit**

```bash
git add src/runtime/circuit-breaker.ts tests/unit/circuit-breaker.test.ts
git commit -m "feat(runtime): three-state circuit breaker (closed/open/half-open)"
```

---

### Task 3: Per-site stack builder

**Files:**
- Create: `src/runtime/build-site-stack.ts`

This function creates a full primitives stack for one site on one dedicated Page. It replaces the multi-site `buildPrimitivesStack` for the per-site scenario.

- [ ] **Step 1: Create the stack builder**

```ts
// src/runtime/build-site-stack.ts
import type { Page } from 'puppeteer-core';
import type { Primitives } from '../primitives/types.js';
import type { SitePlugin } from '../registry/types.js';
import { PuppeteerBackend } from '../primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../primitives/throttle.js';
import { createAuthGuardedPrimitives } from '../primitives/auth-guard.js';
import { RateLimitDetector } from '../primitives/rate-limit-detect.js';

export interface SiteStack {
  /** Auth-guarded outermost wrapper. */
  primitives: Primitives;
  /** Per-site rate limit detector (exposed for diagnostics). */
  rateLimitDetector: RateLimitDetector;
}

/**
 * Build a full primitives stack for a single site on a pre-created Page.
 * Browser lifecycle is managed by SiteRuntimeManager, not this function.
 *
 * Layers (inside → outside):
 *   PuppeteerBackend → RateLimitDetect → Throttle → AuthGuard
 */
export function buildSiteStack(
  page: Page,
  plugin: SitePlugin,
): SiteStack {
  // Build rate-limit detector for this single site
  const siteDetectors: Record<string, (response: {
    url: string; status: number; headers: Record<string, string>; body: string;
  }) => { url: string; resetAt?: Date; reason: string } | null> = {};
  if (plugin.detect) {
    siteDetectors[plugin.name] = plugin.detect;
  }
  const rateLimitDetector = new RateLimitDetector(siteDetectors);

  // Create backend scoped to this site's page and domains
  const backend = new PuppeteerBackend({
    siteDomains: { [plugin.name]: plugin.domains },
    rateLimitDetector,
    page, // Pre-assigned page — backend uses this instead of opening new tabs
  });

  // Throttle layer
  const throttled = createThrottledPrimitives(backend);

  // Auth guard layer
  const authConfigs = plugin.capabilities?.auth
    ? [{
        site: plugin.name,
        domains: plugin.domains,
        check: async (inner: Primitives) => {
          const result = await plugin.capabilities!.auth!.check(inner);
          return result.loggedIn;
        },
      }]
    : [];

  const guarded = createAuthGuardedPrimitives(throttled, authConfigs);

  return { primitives: guarded, rateLimitDetector };
}
```

- [ ] **Step 2: Make PuppeteerBackend constructor backward-compatible**

PuppeteerBackend currently takes `(browser, options?)`. After Plan 2, both call patterns must work:

```ts
// Old (server.ts until Plan 5):
new PuppeteerBackend(browser, { siteDomains, rateLimitDetector })

// New (buildSiteStack):
new PuppeteerBackend({ siteDomains, rateLimitDetector, page })
```

In `src/primitives/puppeteer-backend.ts`, change the constructor to accept both signatures:

```ts
export interface PuppeteerBackendOptions {
  siteDomains?: Record<string, string[]>;
  rateLimitDetector?: RateLimitDetector;
  /** Pre-assigned page for single-site mode. When set, browser is not needed. */
  page?: Page;
}

// Overloaded constructor: (browser, options?) OR (options with page)
constructor(browserOrOptions: Browser | PuppeteerBackendOptions, options?: PuppeteerBackendOptions) {
  let browser: Browser | null;
  let opts: PuppeteerBackendOptions;

  if (browserOrOptions && 'newPage' in browserOrOptions) {
    // Old signature: (browser, options?)
    browser = browserOrOptions as Browser;
    opts = options ?? {};
  } else {
    // New signature: (options with page)
    browser = null;
    opts = browserOrOptions as PuppeteerBackendOptions;
  }

  this.browser = browser;
  // ... existing setup from opts.siteDomains, opts.rateLimitDetector ...

  // Pre-assign page if provided
  if (opts.page) {
    const siteName = Object.keys(this.siteDomains)[0];
    if (siteName) {
      this.pages.set(siteName, opts.page);
      this.currentSite = siteName;
    }
  }
}
```

In `getPage(site)`, add a guard for the no-browser case:

```ts
// Existing: const page = await this.browser.newPage();
// Changed:
if (!this.browser) {
  throw new Error('PuppeteerBackend: no browser and no pre-assigned page for site');
}
const page = await this.browser.newPage();
```

This way:
- **Old callers** (`server.ts` until Plan 5) pass `(browser, options)` — works as before
- **New callers** (`buildSiteStack`) pass `({ page, siteDomains, rateLimitDetector })` — uses pre-assigned page, never calls `browser.newPage()`
- Plan 5 deletes the old call site; a future cleanup can simplify the constructor to new-only

- [ ] **Step 3: Run existing PuppeteerBackend tests to verify no regressions**

Run: `pnpm test tests/unit/puppeteer-backend.test.ts`
Expected: all existing tests PASS (they use the old `(browser, options)` signature)

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 5: Run all existing tests to verify no regressions**

Run: `pnpm test tests/unit`
Expected: all existing tests pass

- [ ] **Step 6: Commit**

```bash
git add src/runtime/build-site-stack.ts src/primitives/puppeteer-backend.ts
git commit -m "feat(runtime): per-site stack builder with pre-assigned page"
```

---

### Task 4: SiteRuntimeManager

**Files:**
- Create: `src/runtime/manager.ts`
- Create: `tests/unit/runtime-manager.test.ts`
- Modify: `src/runtime/index.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/runtime-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteRuntimeManager } from '../../src/runtime/manager.js';
import type { SitePlugin } from '../../src/registry/types.js';
import type { SiteRuntime } from '../../src/runtime/types.js';

function fakePlugin(name: string): SitePlugin {
  return { apiVersion: 1, name, domains: [`${name}.com`] };
}

// Mock the buildSiteStack to avoid real browser
// Returns { primitives, rateLimitDetector } — must match SiteStack interface
vi.mock('../../src/runtime/build-site-stack.js', () => ({
  buildSiteStack: vi.fn((_page: unknown, _plugin: SitePlugin) => ({
    primitives: { navigate: vi.fn(), takeSnapshot: vi.fn() } as never,
    rateLimitDetector: { signals: new Map(), checkAndThrow: vi.fn(), clear: vi.fn() } as never,
  })),
}));

// Mock ensureBrowser to return a fake browser
// browser.newPage() returns a fake Page (Manager calls it before buildSiteStack)
vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(async () => ({
    connected: true,
    newPage: vi.fn(async () => ({ isClosed: () => false, close: vi.fn() })),
    disconnect: vi.fn(),
  })),
}));

describe('SiteRuntimeManager', () => {
  let manager: SiteRuntimeManager;
  const plugins = [fakePlugin('twitter'), fakePlugin('reddit')];

  beforeEach(() => {
    manager = new SiteRuntimeManager(plugins);
  });

  it('creates runtime lazily on first get()', async () => {
    expect(manager.has('twitter')).toBe(false);
    const runtime = await manager.get('twitter');
    expect(runtime).toBeDefined();
    expect(runtime.plugin.name).toBe('twitter');
    expect(manager.has('twitter')).toBe(true);
  });

  it('returns cached runtime on subsequent get()', async () => {
    const first = await manager.get('twitter');
    const second = await manager.get('twitter');
    expect(first).toBe(second);
  });

  it('creates separate runtimes for different sites', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter).not.toBe(reddit);
    expect(twitter.plugin.name).toBe('twitter');
    expect(reddit.plugin.name).toBe('reddit');
  });

  it('throws for unknown site name', async () => {
    await expect(manager.get('nonexistent')).rejects.toThrow(/nonexistent/);
  });

  it('clear() removes a specific site runtime', async () => {
    await manager.get('twitter');
    expect(manager.has('twitter')).toBe(true);
    manager.clear('twitter');
    expect(manager.has('twitter')).toBe(false);
  });

  it('clearAll() removes all runtimes', async () => {
    await manager.get('twitter');
    await manager.get('reddit');
    manager.clearAll();
    expect(manager.has('twitter')).toBe(false);
    expect(manager.has('reddit')).toBe(false);
  });

  it('recreates runtime after clear()', async () => {
    const first = await manager.get('twitter');
    manager.clear('twitter');
    const second = await manager.get('twitter');
    expect(second).not.toBe(first);
  });

  it('each runtime has its own mutex', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.mutex).not.toBe(reddit.mutex);
  });

  it('each runtime has its own circuit breaker', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.circuitBreaker).not.toBe(reddit.circuitBreaker);
  });

  it('concurrent get() for same site returns same runtime (no duplicate creation)', async () => {
    const [a, b] = await Promise.all([
      manager.get('twitter'),
      manager.get('twitter'),
    ]);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/runtime-manager.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement SiteRuntimeManager**

```ts
// src/runtime/manager.ts
import type { Browser } from 'puppeteer-core';
import type { SitePlugin } from '../registry/types.js';
import type { SiteRuntime } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Mutex } from '../mutex.js';
import { buildSiteStack } from './build-site-stack.js';
import { ensureBrowser } from '../browser/browser.js';

export class SiteRuntimeManager {
  private readonly runtimes = new Map<string, SiteRuntime>();
  private readonly pending = new Map<string, Promise<SiteRuntime>>();
  private readonly pluginsByName: Map<string, SitePlugin>;
  private browser: Browser | null = null;

  constructor(plugins: SitePlugin[]) {
    this.pluginsByName = new Map(plugins.map(p => [p.name, p]));
  }

  /** Check if a runtime exists for the given site. */
  has(siteName: string): boolean {
    return this.runtimes.has(siteName);
  }

  /** Get or lazily create a runtime for the given site. */
  async get(siteName: string): Promise<SiteRuntime> {
    const existing = this.runtimes.get(siteName);
    if (existing) return existing;

    // Concurrent creation protection: if another call is already creating
    // the runtime for this site, wait for that instead of creating a second one.
    const inflight = this.pending.get(siteName);
    if (inflight) return inflight;

    const promise = this.createRuntime(siteName);
    this.pending.set(siteName, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(siteName);
    }
  }

  private async createRuntime(siteName: string): Promise<SiteRuntime> {
    const plugin = this.pluginsByName.get(siteName);
    if (!plugin) {
      throw new Error(
        `Unknown site "${siteName}". Available sites: ${[...this.pluginsByName.keys()].join(', ')}`,
      );
    }

    // Ensure browser is running
    if (!this.browser || !this.browser.connected) {
      this.browser = await ensureBrowser({ autoLaunch: true });
    }

    // Build per-site stack
    const page = await this.browser.newPage();
    const { primitives, rateLimitDetector } = buildSiteStack(page, plugin);

    const runtime: SiteRuntime = {
      plugin,
      primitives,
      page,
      mutex: new Mutex(),
      circuitBreaker: new CircuitBreaker(),
      rateLimitDetector,
      authState: { loggedIn: null, lastCheckedAt: null },
    };

    this.runtimes.set(siteName, runtime);
    return runtime;
  }

  /** Clear a specific site's runtime. */
  clear(siteName: string): void {
    const runtime = this.runtimes.get(siteName);
    if (runtime) {
      // Best-effort close the page
      runtime.page.close().catch(() => {});
      this.runtimes.delete(siteName);
    }
  }

  /** Clear all runtimes (e.g. on browser disconnect). */
  clearAll(): void {
    for (const [name] of this.runtimes) {
      this.clear(name);
    }
    this.browser = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/runtime-manager.test.ts`
Expected: all 10 tests PASS

- [ ] **Step 5: Uncomment exports in `src/runtime/index.ts`**

Ensure `src/runtime/index.ts` exports everything:

```ts
export type { SiteRuntime } from './types.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { SiteRuntimeManager } from './manager.js';
export { buildSiteStack } from './build-site-stack.js';
```

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 7: Run all unit tests**

Run: `pnpm test tests/unit`
Expected: all tests pass (existing + new)

- [ ] **Step 8: Commit**

```bash
git add src/runtime/manager.ts src/runtime/index.ts tests/unit/runtime-manager.test.ts
git commit -m "feat(runtime): SiteRuntimeManager with lazy per-site isolation"
```

---

### Task 5: Remove `site?` parameter from Primitives interface

**Files:**
- Modify: `src/primitives/types.ts`
- Modify: `src/primitives/puppeteer-backend.ts`
- Modify: `src/primitives/throttle.ts`
- Modify: `src/primitives/auth-guard.ts`
- Modify: all tests that call primitives with `site?` param

Per design doc Section 10.3: with per-site Primitives instances, the `site?` parameter is redundant. Each instance is bound to one site. Removing it is an intentional breaking change, but impact is internal only — external consumers use `SitePlugin`, not raw Primitives.

- [ ] **Step 1: Remove `site?` from Primitives interface**

In `src/primitives/types.ts`, remove the optional `site?: string` parameter from all methods:

```ts
// Before:
navigate(url: string, site?: string): Promise<void>;
takeSnapshot(site?: string): Promise<Snapshot>;
click(uid: string, site?: string): Promise<void>;
// ... etc

// After:
navigate(url: string): Promise<void>;
takeSnapshot(): Promise<Snapshot>;
click(uid: string): Promise<void>;
type(uid: string, text: string): Promise<void>;
scroll(options: ScrollOptions): Promise<void>;
scrollIntoView(uid: string): Promise<void>;
evaluate<T = unknown>(expression: string): Promise<T>;
screenshot(): Promise<string>;
interceptRequest(urlPattern: string | RegExp, handler: InterceptHandler): Promise<() => void>;
getRawPage(): Promise<Page>;
```

- [ ] **Step 2: Update PuppeteerBackend to not accept site param**

In `src/primitives/puppeteer-backend.ts`, update all method signatures to remove `site?`. The backend now always uses its pre-assigned page (from Task 3 Step 2). If `currentSite` logic is needed, it's set at construction time from the single site in `siteDomains`.

- [ ] **Step 3: Update throttle.ts and auth-guard.ts**

Remove `site?` parameter passthrough in both wrapper layers.

- [ ] **Step 4: Update all call sites in Twitter workflows**

In `src/sites/twitter/workflows.ts`, remove the second argument from all primitives calls:

```ts
// Before:
await primitives.navigate(TWITTER_HOME, TWITTER_SITE);
await primitives.evaluate<string>('window.location.href', TWITTER_SITE);
await primitives.takeSnapshot(TWITTER_SITE);

// After:
await primitives.navigate(TWITTER_HOME);
await primitives.evaluate<string>('window.location.href');
await primitives.takeSnapshot();
```

Same for `src/sites/twitter/site.ts` (authCheck function).

- [ ] **Step 5: Update all existing tests**

Tests that pass `site?` to mock primitives need updating. This is mechanical: remove the second argument from all `primitives.method(arg, 'twitter')` calls in test files.

- [ ] **Step 6: Build and run all tests**

Run: `pnpm run build && pnpm test`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove redundant site? parameter from Primitives interface"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] SiteRuntime interface with all fields (Section 3.1) → Task 1
   - [x] Shared Browser, isolated everything else (Section 3.2) → Task 4 (manager holds browser, runtimes hold per-site resources)
   - [x] Lazy creation on first tool call (Section 3.3.1) → Task 4 (`get()` creates on demand)
   - [x] Cross-site parallelism via per-site mutex (Section 3.3.2) → Task 4 (each runtime has own Mutex)
   - [x] Fault isolation via per-site circuit breaker (Section 3.3.3) → Task 2 + Task 4
   - [x] Browser disconnect clears all runtimes (Section 3.3.4) → Task 4 (`clearAll()`)
   - [x] Per-site tab lifecycle (Section 3.3.5) → Task 3 (`buildSiteStack` opens dedicated tab)
   - [x] SiteRuntimeManager API: get, clear, clearAll (Section 3.4) → Task 4
   - [x] Per-site stack builder (Section 10.4) → Task 3
   - [x] Remove Primitives `site?` parameter (Section 10.3) → Task 5

2. **Placeholder scan:** No TBDs. Task 3 Step 2 describes the PuppeteerBackend modification in detail. Task 5 is mechanical but large-scope — touches many files.

3. **Type consistency:** `SiteRuntime`, `CircuitBreaker`, `SiteRuntimeManager`, `buildSiteStack` — names consistent across all tasks and match the design doc.
