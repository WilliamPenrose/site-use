# M7: Chrome 常驻 + CLI Workflow 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI can execute browser workflows (e.g. `twitter feed`) by connecting to a persistent Chrome instance, sharing it with the MCP server via a cross-process file lock.

**Architecture:** Chrome is launched once in detached mode and stays alive. Both CLI and MCP server use `puppeteer.connect()` to attach. A file-based lock (`op.lock`) serializes browser operations across processes. The rename `timeline → feed` unifies terminology.

**Tech Stack:** Node.js 22+, Puppeteer, node:sqlite, Vitest

**Spec:** `docs/milestones/m7/00-persistent-chrome-and-cli-workflows.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lock.ts` | Cross-process file lock: `acquireLock()`, `releaseLock()`, `withLock()`, `isPidAlive()` |
| `src/cli/workflow.ts` | CLI entry for browser workflows: arg parsing, lock, Primitives, execute, format output |
| `tests/unit/lock.test.ts` | File lock unit tests |
| `tests/unit/browser-connect.test.ts` | Browser connect mode + chrome.json unit tests |
| `tests/integration/cli-workflow.test.ts` | CLI `twitter feed` integration tests |

### Modified files

| File | Change |
|------|--------|
| `src/errors.ts` | Add `BrowserNotRunning` error class |
| `src/config.ts` | Add `chromeJsonPath` property |
| `src/browser/browser.ts` | Add `launchAndDetach()`, refactor `ensureBrowser()` for connect mode |
| `src/index.ts` | New `twitter` CLI route, refactor `browser launch/close` |
| `src/server.ts` | Tool rename, `withLock` wrapper, `ensureBrowser({ autoLaunch: true })` |
| `src/sites/twitter/types.ts` | Rename Timeline* → Feed* types |
| `src/sites/twitter/extractors.ts` | Rename `buildTimelineMeta()` → `buildFeedMeta()` |
| `src/sites/twitter/workflows.ts` | Rename `getTimeline()` → `getFeed()`, param `feed` → `tab` |
| `tests/contract/server.test.ts` | Update tool name and param assertions |
| `tests/unit/twitter-workflows.test.ts` | Update import names |

### Tech debt (not in scope)

`buildPrimitives()` in `src/cli/workflow.ts` duplicates the Primitives stack construction from
`src/server.ts:getPrimitives()`. Future refactor: extract a shared `buildPrimitivesStack(browser)`
helper. Not critical for M7 since the Primitives interface is stable.

---

## Task 1: Add `BrowserNotRunning` error + `chromeJsonPath` config

**Files:**
- Modify: `src/errors.ts:77-86` (add after `StateTransitionFailed`)
- Modify: `src/config.ts:16-22` (Config interface) and `src/config.ts:24-65` (getConfig)

- [ ] **Step 1: Add `BrowserNotRunning` to `src/errors.ts`**

Add after the `StateTransitionFailed` class (line ~86):

```ts
export class BrowserNotRunning extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('BrowserNotRunning', message, {
      retryable: false,
      hint: "Run 'npx site-use browser launch' to start Chrome first.",
      ...context,
    });
  }
}
```

- [ ] **Step 2: Add `chromeJsonPath` to `src/config.ts`**

In the `Config` interface (line ~16), add:

```ts
chromeJsonPath: string;
```

In `getConfig()` (line ~24), after `chromeProfileDir` is computed, add:

```ts
const chromeJsonPath = path.join(dataDir, 'chrome.json');
```

And include it in the returned object.

- [ ] **Step 3: Build and verify**

Run: `pnpm run build`
Expected: Success, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/errors.ts src/config.ts
git commit -m "feat(m7): add BrowserNotRunning error and chromeJsonPath config"
```

---

## Task 2: Implement cross-process file lock (`src/lock.ts`)

**Files:**
- Create: `src/lock.ts`
- Test: `tests/unit/lock.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/lock.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPidAlive, acquireLock, releaseLock, withLock } from '../../src/lock.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('isPidAlive', () => {
  it('returns true for current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(isPidAlive(99999999)).toBe(false);
  });
});

describe('file lock', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-lock-test-' + process.pid);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  });

  it('acquires and releases a lock', async () => {
    await acquireLock({ lockDir: tmpDir });
    const lockPath = path.join(tmpDir, 'op.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('acquires per-site lock with correct filename', async () => {
    await acquireLock({ lockDir: tmpDir, site: 'twitter' });
    const lockPath = path.join(tmpDir, 'op.twitter.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock();
  });

  it('cleans up stale lock from dead PID', async () => {
    const lockPath = path.join(tmpDir, 'op.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }));
    await acquireLock({ lockDir: tmpDir });
    releaseLock();
  });

  it('withLock releases on success', async () => {
    const result = await withLock(async () => 42, { lockDir: tmpDir });
    expect(result).toBe(42);
    expect(fs.existsSync(path.join(tmpDir, 'op.lock'))).toBe(false);
  });

  it('withLock releases on exception', async () => {
    await expect(withLock(async () => { throw new Error('boom'); }, { lockDir: tmpDir }))
      .rejects.toThrow('boom');
    expect(fs.existsSync(path.join(tmpDir, 'op.lock'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit tests/unit/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lock.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;   // Windows: exists but no permission
    return false;
  }
}

interface LockOptions {
  lockDir?: string;
  site?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

let currentLockPath: string | null = null;

function getLockPath(opts: LockOptions = {}): string {
  const dir = opts.lockDir ?? getConfig().dataDir;
  const filename = opts.site ? `op.${opts.site}.lock` : 'op.lock';
  return path.join(dir, filename);
}

export async function acquireLock(opts: LockOptions = {}): Promise<void> {
  const lockPath = getLockPath(opts);
  const pollInterval = opts.pollIntervalMs ?? 500;
  const timeout = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      currentLockPath = lockPath;
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (!isPidAlive(data.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }
}

export function releaseLock(): void {
  if (currentLockPath) {
    try { fs.unlinkSync(currentLockPath); } catch {}
    currentLockPath = null;
  }
}

export async function withLock<T>(
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  await acquireLock(opts);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit tests/unit/lock.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Build and commit**

```bash
pnpm run build
git add src/lock.ts tests/unit/lock.test.ts
git commit -m "feat(m7): cross-process file lock with stale PID recovery"
```

---

## Task 3: Rename timeline → feed (types, extractors, workflows)

**Files:**
- Modify: `src/sites/twitter/types.ts:82-115`
- Modify: `src/sites/twitter/extractors.ts:2,158`
- Modify: `src/sites/twitter/workflows.ts:9,12,85-176`
- Modify: `tests/unit/twitter-workflows.test.ts:29`

Pure rename — no logic changes.

- [ ] **Step 1: Rename types in `src/sites/twitter/types.ts`**

| Before | After |
|--------|-------|
| `TimelineMetaSchema` | `FeedMetaSchema` |
| `TimelineMeta` | `FeedMeta` |
| `TimelineDebug` | `FeedDebug` |
| `feedRequested` field in `FeedDebug` | `tabRequested` |
| `TimelineResultSchema` | `FeedResultSchema` |
| `TimelineResult` | `FeedResult` |

- [ ] **Step 2: Update `src/sites/twitter/extractors.ts`**

- Line 2: `import type { ..., FeedMeta } from './types.js'`
- Line 158: `export function buildFeedMeta(tweets: Tweet[]): FeedMeta {`

- [ ] **Step 3: Update `src/sites/twitter/workflows.ts`**

- Line 9: `buildFeedMeta` import
- Line 12: `import type { RawTweetData, FeedDebug, FeedResult } from './types.js'`
- Line 85: `export async function getFeed(`
- Line 87: Parameter `feed = 'following'` → `tab = 'following'`
- Line 91: Return type `Promise<FeedResult>`
- Line 97: `feedRequested` → `tabRequested` in debug info
- All internal references to `feed` parameter → `tab`
- Line 148: `buildFeedMeta(tweets)`
- Line 150: `const result: FeedResult = { tweets, meta }`

- [ ] **Step 4: Update `tests/unit/twitter-workflows.test.ts`**

- Line 29: change `getTimeline` import to `getFeed`
- Update any test referencing `getTimeline` to use `getFeed`

- [ ] **Step 5: Build and run tests**

Run: `pnpm run build && pnpm test:unit`
Expected: Build succeeds, all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/types.ts src/sites/twitter/extractors.ts src/sites/twitter/workflows.ts tests/unit/twitter-workflows.test.ts
git commit -m "refactor(m7): rename timeline to feed across types, extractors, workflows"
```

---

## Task 4: Browser connect mode + CLI workflow + index.ts refactor

This is the core task. It modifies `browser.ts`, `index.ts`, creates `cli/workflow.ts`,
and updates `server.ts` — all in one commit to avoid intermediate broken states.

**Files:**
- Modify: `src/browser/browser.ts:83-176`
- Create: `src/cli/workflow.ts`
- Modify: `src/index.ts:48-161`
- Modify: `src/server.ts:27-70,216-245`
- Test: `tests/unit/browser-connect.test.ts`
- Test: `tests/integration/cli-workflow.test.ts`

### 4a: Write failing tests

- [ ] **Step 1: Write `chrome.json` lifecycle tests**

Create `tests/unit/browser-connect.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('chrome.json lifecycle', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-chrome-test-' + process.pid);
  const chromeJsonPath = path.join(tmpDir, 'chrome.json');

  beforeEach(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => {
    try { fs.unlinkSync(chromeJsonPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  it('readChromeJson returns null when file missing', async () => {
    const { readChromeJson } = await import('../../src/browser/browser.js');
    expect(readChromeJson(chromeJsonPath)).toBeNull();
  });

  it('writeChromeJson writes valid JSON', async () => {
    const { writeChromeJson, readChromeJson } = await import('../../src/browser/browser.js');
    writeChromeJson(chromeJsonPath, { pid: 12345, wsEndpoint: 'ws://127.0.0.1:9222/foo' });
    const info = readChromeJson(chromeJsonPath);
    expect(info).toEqual({ pid: 12345, wsEndpoint: 'ws://127.0.0.1:9222/foo' });
  });

  it('readChromeJson cleans up when PID is dead', async () => {
    const { readChromeJson } = await import('../../src/browser/browser.js');
    fs.writeFileSync(chromeJsonPath, JSON.stringify({ pid: 99999999, wsEndpoint: 'ws://dead' }));
    expect(readChromeJson(chromeJsonPath)).toBeNull();
    expect(fs.existsSync(chromeJsonPath)).toBe(false);
  });

  it('readChromeJson returns info when PID is alive', async () => {
    const { readChromeJson } = await import('../../src/browser/browser.js');
    fs.writeFileSync(chromeJsonPath, JSON.stringify({ pid: process.pid, wsEndpoint: 'ws://alive' }));
    const info = readChromeJson(chromeJsonPath);
    expect(info).toEqual({ pid: process.pid, wsEndpoint: 'ws://alive' });
  });
});
```

- [ ] **Step 2: Write CLI integration tests**

Create `tests/integration/cli-workflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const bin = path.resolve('dist/index.js');

describe('CLI twitter feed', () => {
  it('prints error when Chrome is not running', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'feed'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          SITE_USE_DATA_DIR: path.join(process.env.TEMP ?? '/tmp', 'site-use-test-no-chrome'),
        },
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('BrowserNotRunning');
      expect(err.stderr).toContain('hint');
    }
  });

  it('prints error for unknown twitter action', () => {
    try {
      execFileSync('node', [bin, 'twitter', 'unknown'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          SITE_USE_DATA_DIR: path.join(process.env.TEMP ?? '/tmp', 'site-use-test-no-chrome'),
        },
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('Unknown');
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:unit tests/unit/browser-connect.test.ts`
Expected: FAIL — `readChromeJson` / `writeChromeJson` not exported.

### 4b: Implement `browser.ts` changes

- [ ] **Step 4: Add chrome.json helpers to `src/browser/browser.ts`**

Add imports at top:

```ts
import { isPidAlive } from '../lock.js';
import { BrowserNotRunning } from '../errors.js';
```

Add exported types and helpers:

```ts
export interface ChromeInfo {
  pid: number;
  wsEndpoint: string;
}

export function readChromeJson(chromeJsonPath: string): ChromeInfo | null {
  try {
    const data = JSON.parse(fs.readFileSync(chromeJsonPath, 'utf-8'));
    if (!isPidAlive(data.pid)) {
      try { fs.unlinkSync(chromeJsonPath); } catch {}
      return null;
    }
    return { pid: data.pid, wsEndpoint: data.wsEndpoint };
  } catch {
    return null;
  }
}

export function writeChromeJson(chromeJsonPath: string, info: ChromeInfo): void {
  fs.writeFileSync(chromeJsonPath, JSON.stringify(info));
}
```

- [ ] **Step 5: Extract arg-building into `buildLaunchArgs()` helper**

Move lines 90-113 from current `ensureBrowser()` into:

```ts
function buildLaunchArgs(config: Config, extraArgs?: string[]): string[] {
  // existing arg-building logic extracted here
  const args = [...];
  if (extraArgs) args.push(...extraArgs);
  return args;
}
```

- [ ] **Step 6: Implement `launchAndDetach()`**

```ts
export async function launchAndDetach(extraArgs?: string[]): Promise<ChromeInfo> {
  const config = getConfig();
  const args = buildLaunchArgs(config, extraArgs);
  fixPreferences(config.chromeProfileDir, config.webrtcPolicy);

  const browser = await puppeteer.launch({
    channel: 'chrome',
    headless: false,
    defaultViewport: null,
    args,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  const pid = browser.process()!.pid!;
  const wsEndpoint = browser.wsEndpoint();
  const info: ChromeInfo = { pid, wsEndpoint };
  writeChromeJson(config.chromeJsonPath, info);

  // Welcome page / blank tab handling (existing logic)
  const pages = await browser.pages();
  const blank = pages.find((p) => p.url() === 'about:blank');
  if (blank && pages.length === 1) {
    const html = buildWelcomeHTML();
    await blank.goto(`data:text/html,${encodeURIComponent(html)}`);
  } else if (blank && pages.length > 1) {
    await blank.close();
  }

  // Do NOT apply emulateFocus/applyCoordFix here —
  // they are registered on the Puppeteer Browser object and would be
  // lost immediately on disconnect. Hooks are applied in ensureBrowser()
  // when a client actually connects.

  browser.disconnect();  // Detach — Chrome stays alive
  return info;
}
```

- [ ] **Step 7: Refactor `ensureBrowser()` for connect mode**

Replace the existing `ensureBrowser()` (lines 83-168):

```ts
interface EnsureBrowserOptions {
  autoLaunch?: boolean;    // default: false
  extraArgs?: string[];
}

export async function ensureBrowser(opts: EnsureBrowserOptions = {}): Promise<Browser> {
  const { autoLaunch = false, extraArgs } = opts;

  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  browserInstance = null;

  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);

  if (!info) {
    if (!autoLaunch) {
      throw new BrowserNotRunning(
        `Chrome not running. Run 'npx site-use browser launch' first. (checked: ${config.chromeJsonPath})`,
      );
    }
    await launchAndDetach(extraArgs);
    return ensureBrowser({ autoLaunch: false, extraArgs });
  }

  try {
    browserInstance = await puppeteer.connect({ browserWSEndpoint: info.wsEndpoint });
  } catch {
    try { fs.unlinkSync(config.chromeJsonPath); } catch {}
    if (!autoLaunch) {
      throw new BrowserNotRunning(
        `Chrome not running (stale chrome.json cleaned). Run 'npx site-use browser launch' first.`,
      );
    }
    await launchAndDetach(extraArgs);
    return ensureBrowser({ autoLaunch: false, extraArgs });
  }

  browserInstance.on('disconnected', () => { browserInstance = null; });

  // Apply hooks on every connect — new connection does not inherit listeners
  const pages = await browserInstance.pages();
  await emulateFocus(pages);
  await applyCoordFix(pages);
  browserInstance.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const page = await target.page();
      if (page) await emulateFocus([page]);
      if (page) await applyCoordFix([page]);
    }
  });

  // Proxy auth (page-level) — reapply on reconnect
  if (config.proxy?.username) {
    const page = pages[0];
    if (page) {
      await page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password ?? '',
      });
    }
  }

  return browserInstance;
}
```

- [ ] **Step 8: Update `closeBrowser()` to async + kill Chrome**

```ts
export async function closeBrowser(): Promise<void> {
  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);

  if (!info) {
    browserInstance = null;
    return;
  }

  try {
    const browser = browserInstance?.connected
      ? browserInstance
      : await puppeteer.connect({ browserWSEndpoint: info.wsEndpoint });
    await browser.close();
  } catch {
    // Chrome already dead
  }

  browserInstance = null;
  try { fs.unlinkSync(config.chromeJsonPath); } catch {}
}
```

- [ ] **Step 9: Run chrome.json tests**

Run: `pnpm test:unit tests/unit/browser-connect.test.ts`
Expected: All 4 tests PASS.

### 4c: Create `src/cli/workflow.ts`

- [ ] **Step 10: Implement `src/cli/workflow.ts`**

```ts
import { ensureBrowser } from '../browser/browser.js';
import { withLock } from '../lock.js';
import { getConfig } from '../config.js';
import { createStore } from '../storage/index.js';
import { getFeed } from '../sites/twitter/workflows.js';
import { createThrottledPrimitives } from '../primitives/throttle.js';
import { createAuthGuardedPrimitives } from '../primitives/auth-guard.js';
import { PuppeteerBackend } from '../primitives/puppeteer-backend.js';
import { RateLimitDetector } from '../primitives/rate-limit-detect.js';
import { twitterSite, twitterDetect } from '../sites/twitter/site.js';
import { matchByRule, rules } from '../sites/twitter/matchers.js';
import type { KnowledgeStore } from '../storage/index.js';
import type { Primitives } from '../primitives/types.js';
import type { Browser } from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

interface FeedArgs {
  count: number;
  tab: 'following' | 'for_you';
  debug: boolean;
  json: boolean;
}

function parseFeedArgs(args: string[]): FeedArgs {
  const result: FeedArgs = { count: 20, tab: 'following', debug: false, json: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--count': result.count = Math.max(1, Math.min(100, Number(args[++i]) || 20)); break;
      case '--tab': result.tab = args[++i] === 'for_you' ? 'for_you' : 'following'; break;
      case '--debug': result.debug = true; break;
      case '--json': result.json = true; break;
    }
  }
  return result;
}

function buildPrimitives(browser: Browser): Primitives {
  const detector = new RateLimitDetector({ twitter: twitterDetect });
  const raw = new PuppeteerBackend(browser, {
    [twitterSite.name]: [...twitterSite.domains],
  }, detector);
  const throttled = createThrottledPrimitives(raw);
  return createAuthGuardedPrimitives(throttled, [{
    site: twitterSite.name,
    domains: [...twitterSite.domains],
    check: async (inner) => {
      const currentUrl = await inner.evaluate<string>('window.location.href', 'twitter');
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) return false;
      const snapshot = await inner.takeSnapshot('twitter');
      return !!matchByRule(snapshot, rules.homeNavLink);
    },
  }]);
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).format(new Date(iso));
}

function formatHumanReadable(result: any): string {
  const lines: string[] = [];
  const ingest = result.ingest;
  if (ingest) {
    const total = ingest.inserted + ingest.duplicates;
    lines.push(`Collected ${total} tweets (${ingest.inserted} new, ${ingest.duplicates} duplicates)`);
    if (ingest.timeRange) {
      lines.push(`Time range: ${formatTimestamp(ingest.timeRange.from)} — ${formatTimestamp(ingest.timeRange.to)}`);
    }
    lines.push('');
  }
  for (const tweet of result.tweets ?? []) {
    lines.push(`@${tweet.author?.handle ?? 'unknown'} · ${formatTimestamp(tweet.timestamp)}`);
    lines.push(tweet.text);
    const metrics = tweet.metrics;
    if (metrics) {
      const parts: string[] = [];
      if (metrics.likes != null) parts.push(`likes: ${metrics.likes.toLocaleString()}`);
      if (metrics.retweets != null) parts.push(`retweets: ${metrics.retweets.toLocaleString()}`);
      if (parts.length) lines.push(parts.join('  '));
    }
    if (tweet.url) lines.push(tweet.url);
    lines.push('───────────────────────────────────');
  }
  return lines.join('\n');
}

async function runTwitterFeed(args: string[]): Promise<void> {
  const { count, tab, debug, json } = parseFeedArgs(args);
  const config = getConfig();
  const dbPath = path.join(config.dataDir, 'data', 'knowledge.db');

  const result = await withLock(async () => {
    const browser = await ensureBrowser();  // autoLaunch=false (CLI default)
    try {
      const primitives = buildPrimitives(browser);
      let store: KnowledgeStore | undefined;
      try {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        store = createStore(dbPath);
        return await getFeed(primitives, count, tab, debug, store);
      } finally {
        store?.close();
      }
    } finally {
      browser.disconnect();
    }
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanReadable(result));
  }
}

export async function runWorkflowCli(site: string, args: string[]): Promise<void> {
  if (site !== 'twitter') {
    process.stderr.write(JSON.stringify({
      error: 'UnknownSite',
      message: `Unknown site: ${site}`,
      hint: 'Available sites: twitter',
    }) + '\n');
    process.exitCode = 1;
    return;
  }

  const action = args[0];
  try {
    switch (action) {
      case 'feed':
        await runTwitterFeed(args.slice(1));
        break;
      default:
        process.stderr.write(JSON.stringify({
          error: 'UnknownAction',
          message: `Unknown twitter action: ${action}`,
          hint: 'Available actions: feed',
        }) + '\n');
        process.exitCode = 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const type = (err as any)?.type ?? 'InternalError';
    const hint = (err as any)?.context?.hint ?? '';
    process.stderr.write(JSON.stringify({ error: type, message, hint }) + '\n');
    process.exitCode = 1;
  }
}
```

### 4d: Update `src/index.ts`

- [ ] **Step 11: Refactor `browserLaunch()`**

Replace lines 48-86 with:

```ts
async function browserLaunch(): Promise<void> {
  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);
  if (info) {
    console.log(`Chrome already running (pid ${info.pid})`);
    return;
  }
  const launched = await launchAndDetach();
  console.log(`Chrome launched (pid ${launched.pid})`);
}
```

Add imports: `launchAndDetach`, `readChromeJson` from `./browser/browser.js`.

- [ ] **Step 12: Refactor `browserClose()` (now async)**

Replace lines 102-105 with:

```ts
async function browserClose(): Promise<void> {
  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);
  if (!info) {
    console.log('Chrome not running');
    return;
  }
  await closeBrowser();
  console.log('Chrome closed');
}
```

- [ ] **Step 13: Refactor `browserStatus()` to use `readChromeJson`**

```ts
async function browserStatus(): Promise<void> {
  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);
  if (info) {
    console.log(`Chrome running (pid ${info.pid}, ${info.wsEndpoint})`);
  } else {
    console.log('Chrome not running');
  }
}
```

- [ ] **Step 14: Add `twitter` route to switch/case**

In the switch block (line ~111), add:

```ts
case 'twitter':
  await runWorkflowCli('twitter', args.slice(1));
  break;
```

Import `runWorkflowCli` from `./cli/workflow.js`.

- [ ] **Step 15: Update HELP text**

Add `twitter feed` to HELP message. Remove `--diagnose` / `--keep-open` from BROWSER_HELP.

### 4e: Update `src/server.ts`

- [ ] **Step 16: Update `getPrimitives()` to use `autoLaunch: true`**

Line 36, change:
```ts
const browser = await ensureBrowser({ autoLaunch: true });
```

- [ ] **Step 17: Rename tool + param + wrap with `withLock`**

Rename `twitter_timeline` → `twitter_feed`, param `feed` → `tab`.
Update handler to call `getFeed()` with `tab`.

Wrap all three tools (`twitter_check_login`, `twitter_feed`, `screenshot`) with `withLock`:

```ts
async ({ count, tab, debug }) => {
  return withLock(async () => {
    return mutex.run(async () => {
      // existing handler logic, but call getFeed instead of getTimeline
    });
  });
},
```

- [ ] **Step 18: Update imports**

```ts
import { withLock } from './lock.js';
import { getFeed } from './sites/twitter/workflows.js';  // was getTimeline
```

### 4f: Build and test

- [ ] **Step 19: Build**

Run: `pnpm run build`
Expected: Success.

- [ ] **Step 20: Run unit tests**

Run: `pnpm test:unit`
Expected: All pass (including browser-connect tests).

- [ ] **Step 21: Run integration tests**

Run: `pnpm test:integration tests/integration/cli-workflow.test.ts`
Expected: Both CLI tests PASS (BrowserNotRunning error + unknown action error).

- [ ] **Step 22: Commit**

```bash
git add src/browser/browser.ts src/cli/workflow.ts src/index.ts src/server.ts tests/unit/browser-connect.test.ts tests/integration/cli-workflow.test.ts
git commit -m "feat(m7): browser connect mode, CLI twitter feed command, withLock in MCP server"
```

---

## Task 5: Update contract tests

**Files:**
- Modify: `tests/contract/server.test.ts`

- [ ] **Step 1: Update tool name assertion**

Line 57, change:
```ts
expect(toolNames).toContain('twitter_feed');  // was twitter_timeline
```

- [ ] **Step 2: Update parameter references**

Search for `feed` parameter references and rename to `tab`.

- [ ] **Step 3: Run contract tests**

Run: `pnpm test:contract`
Expected: All PASS.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (unit + integration + contract).

- [ ] **Step 5: Commit**

```bash
git add tests/contract/
git commit -m "test(m7): update contract tests for twitter_feed rename"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Manual smoke test** (requires Chrome installed)

```bash
npx site-use browser launch
npx site-use browser status
npx site-use twitter feed --count 5 --tab following
npx site-use twitter feed --count 5 --json
npx site-use search "test"
npx site-use browser close
```

These manual steps cover spec test items not automatable without a real browser:

| Spec test item | Covered by |
|----------------|-----------|
| `browser launch` writes chrome.json | smoke: `browser launch` + `browser status` |
| `browser launch` idempotency | smoke: run `browser launch` twice |
| `browser close` cleanup | smoke: `browser close` + `browser status` |
| connect 后 hook 重放 (emulateFocus/applyCoordFix) | smoke: `twitter feed` succeeds (hooks are required for anti-detection) |
| Chrome 操作中崩溃 | smoke: kill Chrome during `twitter feed`, verify error + recovery |
| MCP + CLI 锁协调 | smoke: start MCP server, run CLI `twitter feed` simultaneously |
| 用户手动关闭 Chrome 窗口 | smoke: close Chrome window, run `twitter feed`, verify error |
| CLI feed → search 全链路 | smoke: `twitter feed` then `search` finds tweets (e2e) |

- [ ] **Step 3: Verify CLI error when Chrome not running**

```bash
npx site-use browser close
npx site-use twitter feed --count 5
# Expected: stderr with BrowserNotRunning + hint, exit code 1
```

- [ ] **Step 4: Verify lock contention**

Open two terminals:
- Terminal 1: `npx site-use twitter feed --count 50`
- Terminal 2 (immediately): `npx site-use twitter feed --count 5`
- Expected: Terminal 2 waits, then executes after Terminal 1 finishes.

- [ ] **Step 5: Update GitNexus index**

Run: `npx gitnexus analyze`
