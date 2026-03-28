# Request Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add framework-level request tracing so every MCP tool call automatically produces a structured span tree on failure (with screenshot), and optionally on success when `debug: true`.

**Architecture:** A lightweight `Trace` class (inspired by OTel spans + Sentry's "collect always, send on error" pattern) is created per request in `wrapToolHandler`, passed through `codegen.ts` closures to workflow functions, which wrap key steps in `trace.span()`. On error, the span tree + a screenshot image block are included in the MCP response. On success with `debug: true`, only the span tree is returned.

**Tech Stack:** TypeScript, Vitest, no external dependencies.

**Spec:** `docs/milestones/m3/06-request-trace.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/trace.ts` | Create | Trace class, SpanHandle interface, NOOP_TRACE/NOOP_SPAN, TraceData/SpanData types |
| `src/__tests__/trace.test.ts` | Create | Unit tests for Trace class |
| `src/registry/types.ts` | Modify | Add `trace?: Trace` to `FeedCapability.collect` and `WorkflowDeclaration.execute`; remove `FeedResult.debug` |
| `src/registry/tool-wrapper.ts` | Modify | Add `trace` to `WrapOptions.handler`; create Trace and inject; move screenshot from `formatError` to image block; pass trace to `formatError` |
| `src/registry/codegen.ts` | Modify | Transparently pass trace through handler closures; remove `debug` from `FeedResultSchema` |
| `src/sites/twitter/types.ts` | Modify | Remove `FeedDebug` interface and `FeedResult.debug` field |
| `src/sites/twitter/workflows.ts` | Modify | Add `trace`/`span` params with NOOP defaults; wrap steps in `span()`; remove debug assembly |
| `src/sites/twitter/__tests__/workflows.test.ts` | Modify | Update debug test to assert trace span tree structure |

---

### Task 1: Trace class and unit tests

**Files:**
- Create: `src/trace.ts`
- Create: `src/__tests__/trace.test.ts`

- [ ] **Step 1: Write failing tests for Trace core behavior**

Create `src/__tests__/trace.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Trace, NOOP_TRACE, NOOP_SPAN, type TraceData, type SpanData } from '../trace.js';

describe('Trace', () => {
  it('records a successful span with timing and attrs', async () => {
    const trace = new Trace('test_tool');
    await trace.span('step1', async (s) => {
      s.set('key', 'value');
      s.set('count', 42);
    });
    const data = trace.toJSON();

    expect(data.tool).toBe('test_tool');
    expect(data.status).toBe('ok');
    expect(data.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(data.root.children).toHaveLength(1);

    const span = data.root.children[0];
    expect(span.name).toBe('step1');
    expect(span.status).toBe('ok');
    expect(span.startMs).toBeGreaterThanOrEqual(0);
    expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
    expect(span.attrs).toEqual({ key: 'value', count: 42 });
    expect(span.error).toBeUndefined();
  });

  it('records an error span and propagates the exception', async () => {
    const trace = new Trace('test_tool');
    await expect(
      trace.span('failing', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const data = trace.toJSON();
    expect(data.status).toBe('error');

    const span = data.root.children[0];
    expect(span.status).toBe('error');
    expect(span.error).toBe('boom');
    expect(span.endMs).not.toBeNull();
  });

  it('supports nested spans', async () => {
    const trace = new Trace('test_tool');
    await trace.span('parent', async (p) => {
      await p.span('child1', async (c) => {
        c.set('x', 1);
      });
      await p.span('child2', async (c) => {
        c.set('x', 2);
      });
    });

    const data = trace.toJSON();
    const parent = data.root.children[0];
    expect(parent.name).toBe('parent');
    expect(parent.children).toHaveLength(2);
    expect(parent.children[0].name).toBe('child1');
    expect(parent.children[0].attrs).toEqual({ x: 1 });
    expect(parent.children[1].name).toBe('child2');
    expect(parent.children[1].attrs).toEqual({ x: 2 });
  });

  it('marks parent as error when child throws', async () => {
    const trace = new Trace('test_tool');
    await expect(
      trace.span('parent', async (p) => {
        await p.span('ok_child', async () => {});
        await p.span('bad_child', async () => {
          throw new Error('child failed');
        });
      }),
    ).rejects.toThrow('child failed');

    const data = trace.toJSON();
    const parent = data.root.children[0];
    expect(parent.status).toBe('error');
    expect(parent.children[0].status).toBe('ok');
    expect(parent.children[1].status).toBe('error');
  });

  it('silently ignores set() after span ends', async () => {
    const trace = new Trace('test_tool');
    let capturedSpan: any;
    await trace.span('step', async (s) => {
      capturedSpan = s;
      s.set('during', true);
    });
    // span has ended — set should be silently ignored
    capturedSpan.set('after', true);

    const span = trace.toJSON().root.children[0];
    expect(span.attrs).toEqual({ during: true });
  });

  it('returns span result value', async () => {
    const trace = new Trace('test_tool');
    const result = await trace.span('compute', async () => {
      return 42;
    });
    expect(result).toBe(42);
  });
});

describe('NOOP_TRACE', () => {
  it('executes fn without recording', async () => {
    const result = await NOOP_TRACE.span('anything', async (s) => {
      s.set('key', 'value');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('supports nested spans', async () => {
    const result = await NOOP_TRACE.span('parent', async (s) => {
      return await s.span('child', async () => 99);
    });
    expect(result).toBe(99);
  });

  it('toJSON returns empty trace', () => {
    const data = NOOP_TRACE.toJSON();
    expect(data.tool).toBe('');
    expect(data.root.children).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/src/zyb/site-use && pnpm exec vitest run src/__tests__/trace.test.ts`
Expected: FAIL — `Cannot find module '../trace.js'`

- [ ] **Step 3: Implement Trace class**

Create `src/trace.ts`:

```typescript
// src/trace.ts — Lightweight request-level tracing for MCP tool calls.

export interface SpanData {
  name: string;
  startMs: number;
  endMs: number | null;
  status: 'ok' | 'error' | 'running';
  attrs: Record<string, string | number | boolean>;
  error?: string;
  children: SpanData[];
}

export interface TraceData {
  tool: string;
  startedAt: string;
  elapsedMs: number;
  status: 'ok' | 'error';
  root: SpanData;
}

export interface SpanHandle {
  set(key: string, value: string | number | boolean): void;
  span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}

class InternalSpan {
  readonly data: SpanData;
  private ended = false;
  private readonly t0: number;

  constructor(name: string, t0: number) {
    this.t0 = t0;
    this.data = {
      name,
      startMs: Date.now() - t0,
      endMs: null,
      status: 'running',
      attrs: {},
      children: [],
    };
  }

  readonly handle: SpanHandle = {
    set: (key, value) => {
      if (this.ended) return;
      this.data.attrs[key] = value;
    },
    span: <T>(name: string, fn: (span: SpanHandle) => Promise<T>) => {
      return this.runChild(name, fn);
    },
  };

  end(status: 'ok' | 'error', error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.data.status = status;
    this.data.endMs = Date.now() - this.t0;
    if (error !== undefined) this.data.error = error;
  }

  private async runChild<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const child = new InternalSpan(name, this.t0);
    this.data.children.push(child.data);
    try {
      const result = await fn(child.handle);
      child.end('ok');
      return result;
    } catch (err) {
      child.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

export class Trace {
  private readonly t0: number;
  private readonly root: InternalSpan;
  private readonly toolName: string;
  private readonly startedAt: string;

  constructor(tool: string) {
    this.toolName = tool;
    this.t0 = Date.now();
    this.startedAt = new Date(this.t0).toISOString();
    this.root = new InternalSpan('root', this.t0);
  }

  async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const child = new InternalSpan(name, this.t0);
    this.root.data.children.push(child.data);
    try {
      const result = await fn(child.handle);
      child.end('ok');
      return result;
    } catch (err) {
      child.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  toJSON(): TraceData {
    const elapsedMs = Date.now() - this.t0;
    const hasError = this.root.data.children.some((c) => c.status === 'error');
    return {
      tool: this.toolName,
      startedAt: this.startedAt,
      elapsedMs,
      status: hasError ? 'error' : 'ok',
      root: {
        name: this.root.data.name,
        startMs: 0,
        endMs: elapsedMs,
        status: hasError ? 'error' : 'ok',
        attrs: this.root.data.attrs,
        error: this.root.data.error,
        children: this.root.data.children,
      },
    };
  }
}

export const NOOP_SPAN: SpanHandle = {
  set() {},
  async span<T>(_name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
};

export const NOOP_TRACE: Trace = {
  async span<T>(_name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
  toJSON(): TraceData {
    return {
      tool: '',
      startedAt: '',
      elapsedMs: 0,
      status: 'ok',
      root: { name: '', startMs: 0, endMs: 0, status: 'ok', attrs: {}, children: [] },
    };
  },
} as Trace;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/src/zyb/site-use && pnpm run build && pnpm exec vitest run src/__tests__/trace.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/trace.ts src/__tests__/trace.test.ts
git commit -m "feat(trace): add Trace class with span tree, NOOP_TRACE, and unit tests"
```

---

### Task 2: Plugin contract changes — registry/types.ts

**Files:**
- Modify: `src/registry/types.ts:63-67` (FeedResult), `src/registry/types.ts:97` (FeedCapability.collect), `src/registry/types.ts:112` (WorkflowDeclaration.execute)

- [ ] **Step 1: Update FeedResult — remove debug field**

In `src/registry/types.ts`, change:

```typescript
export interface FeedResult {
  items: FeedItem[];
  meta: FeedMeta;
  debug?: Record<string, unknown>;
}
```

to:

```typescript
export interface FeedResult {
  items: FeedItem[];
  meta: FeedMeta;
}
```

- [ ] **Step 2: Add trace import and update FeedCapability.collect signature**

Add import at top of `src/registry/types.ts`:

```typescript
import type { Trace } from '../trace.js';
```

Change `FeedCapability.collect` from:

```typescript
collect: (primitives: Primitives, params: unknown) => Promise<FeedResult>;
```

to:

```typescript
collect: (primitives: Primitives, params: unknown, trace?: Trace) => Promise<FeedResult>;
```

- [ ] **Step 3: Update WorkflowDeclaration.execute signature**

Change `WorkflowDeclaration.execute` from:

```typescript
execute: (primitives: Primitives, params: unknown) => Promise<unknown>;
```

to:

```typescript
execute: (primitives: Primitives, params: unknown, trace?: Trace) => Promise<unknown>;
```

- [ ] **Step 4: Build to verify no type errors**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds (existing code still compiles because trace is optional)

- [ ] **Step 5: Commit**

```bash
git add src/registry/types.ts
git commit -m "feat(trace): add trace param to FeedCapability.collect and WorkflowDeclaration.execute"
```

---

### Task 3: wrapToolHandler and formatError changes

**Files:**
- Modify: `src/registry/tool-wrapper.ts`

- [ ] **Step 1: Add Trace import and update WrapOptions**

In `src/registry/tool-wrapper.ts`, add import:

```typescript
import { Trace, type TraceData } from '../trace.js';
```

Add `toolName` field and update `handler` signature in `WrapOptions`:

```typescript
export interface WrapOptions {
  siteName: string;
  toolName: string;  // MCP tool name (e.g. 'twitter_feed') — used as Trace identifier
  handler: (params: Record<string, unknown>, runtime: SiteRuntime, trace: Trace) => Promise<unknown>;
  getRuntime: () => Promise<SiteRuntime>;
  paramsSchema?: ZodType;
  resultSchema?: ZodType;
  onBrowserDisconnected?: () => void;
  autoIngest?: {
    storeAdapter: { toIngestItems: (items: any[]) => any[] };
    siteName: string;
  };
}
```

- [ ] **Step 2: Update formatError — add trace param, remove screenshot**

Change `formatError` signature from:

```typescript
async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
): Promise<ToolResult> {
```

to:

```typescript
async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
  trace?: TraceData,
): Promise<ToolResult> {
```

In the `SiteUseError` branch, **remove** the screenshot lines (lines 134-139):

```typescript
    if (!(err instanceof BrowserDisconnected) && runtime) {
      try {
        context.screenshotBase64 = await runtime.primitives.screenshot();
      } catch {
        // screenshot failed, skip
      }
    }
```

And in both branches (SiteUseError and generic error), add trace to the payload. For the SiteUseError branch, before the return, add:

```typescript
    const payload: Record<string, unknown> = {
      type: err.type,
      message: err.message,
      site: siteName,
      context,
    };
    if (trace) payload.trace = trace;

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      isError: true,
    };
```

For the generic error branch, change to:

```typescript
  if (runtime) runtime.circuitBreaker.recordError();
  const payload: Record<string, unknown> = {
    type: 'PluginError',
    message: `Plugin "${siteName}" threw an unexpected error: ${err.message}`,
    site: siteName,
    context: { originalError: err.message, retryable: false },
  };
  if (trace) payload.trace = trace;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
```

- [ ] **Step 3: Update wrapToolHandler — create Trace, inject, handle debug/error**

In the `wrapToolHandler` returned closure, create Trace after runtime is available, pass it to handler, handle debug response and error screenshot.

After the `paramsSchema` validation block and before the `try { const result = ...` block, add:

```typescript
    const trace = new Trace(opts.toolName);
```

Change the handler call from:

```typescript
      const result = await runtime.mutex.run(async () => {
        return await opts.handler(rawParams, runtime);
      });
```

to:

```typescript
      const result = await runtime.mutex.run(async () => {
        return await opts.handler(rawParams, runtime, trace);
      });
```

Change the success return (lines 107-110) from:

```typescript
      runtime.circuitBreaker.recordSuccess();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
```

to:

```typescript
      runtime.circuitBreaker.recordSuccess();
      if ((rawParams as Record<string, unknown>).debug) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ result, trace: trace.toJSON() }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
```

Change the error handler (line 112) from:

```typescript
      return formatError(opts.siteName, err as Error, runtime, opts.onBrowserDisconnected);
```

to:

```typescript
      const errorResult = await formatError(opts.siteName, err as Error, runtime, opts.onBrowserDisconnected, trace.toJSON());

      // Screenshot as MCP image content block
      try {
        if (!(err instanceof BrowserDisconnected) && runtime?.primitives?.screenshot) {
          const screenshot = await runtime.primitives.screenshot();
          errorResult.content.push({ type: 'image' as const, data: screenshot, mimeType: 'image/png' });
        }
      } catch {
        // Screenshot failed — skip, don't cause secondary failure
      }

      return errorResult;
```

Add `BrowserDisconnected` to the import if not already imported (it is — line 3).

- [ ] **Step 4: Build to verify no type errors**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/registry/tool-wrapper.ts
git commit -m "feat(trace): inject Trace in wrapToolHandler, move screenshot to image block"
```

---

### Task 4: codegen.ts — pass trace through handler closures

**Files:**
- Modify: `src/registry/codegen.ts:14-32` (FeedResultSchema), `src/registry/codegen.ts:76` (auth handler), `src/registry/codegen.ts:103` (feed handler), `src/registry/codegen.ts:134` (customWorkflow handler)

- [ ] **Step 1: Add Trace import**

Add to imports in `src/registry/codegen.ts`:

```typescript
import type { Trace } from '../trace.js';
```

- [ ] **Step 2: Remove debug from FeedResultSchema**

Change:

```typescript
const FeedResultSchema = z.object({
  items: z.array(FeedItemSchema),
  meta: z.object({
    coveredUsers: z.array(z.string()),
    timeRange: z.object({ from: z.string(), to: z.string() }),
  }),
  debug: z.record(z.unknown()).optional(),
});
```

to:

```typescript
const FeedResultSchema = z.object({
  items: z.array(FeedItemSchema),
  meta: z.object({
    coveredUsers: z.array(z.string()),
    timeRange: z.object({ from: z.string(), to: z.string() }),
  }),
});
```

- [ ] **Step 3: Add toolName to all wrapToolHandler calls**

Every `wrapToolHandler({...})` call in `generateMcpTools` and `generateCliCommands` needs `toolName` added. The tool name is already computed as the `name` field in each `tools.push({ name: ... })` call.

For auth: `toolName: \`${plugin.name}_check_login\``
For feed: `toolName: \`${plugin.name}_feed\``
For customWorkflows: `toolName: \`${plugin.name}_${wf.name}\``

Add `toolName` to every `wrapToolHandler({...})` call alongside `siteName`.

- [ ] **Step 4: Update auth handler closure to accept and ignore trace**

Change `generateMcpTools` auth handler (line 76) from:

```typescript
          handler: async (_params, runtime) => {
            return await authCheck(runtime.primitives);
          },
```

to:

```typescript
          handler: async (_params, runtime, _trace) => {
            return await authCheck(runtime.primitives);
          },
```

- [ ] **Step 5: Update feed handler closure to pass trace**

Change `generateMcpTools` feed handler (line 103) from:

```typescript
          handler: async (params, runtime) => {
            const result = await feedCollect(runtime.primitives, params);
```

to:

```typescript
          handler: async (params, runtime, trace) => {
            const result = await feedCollect(runtime.primitives, params, trace);
```

- [ ] **Step 6: Update customWorkflow handler closure to pass trace**

Change `generateMcpTools` customWorkflow handler (line 134) from:

```typescript
            handler: async (params, runtime) => {
              return await wf.execute(runtime.primitives, params);
            },
```

to:

```typescript
            handler: async (params, runtime, trace) => {
              return await wf.execute(runtime.primitives, params, trace);
            },
```

- [ ] **Step 7: Update generateCliCommands — same changes for CLI handler closures**

Apply identical changes to the CLI handler closures in `generateCliCommands`:

Auth CLI handler (~line 179): `async (_params, runtime, _trace) =>`

Feed CLI handler (~line 213): `async (params, runtime, trace) =>` and pass trace to `feedCollect`

CustomWorkflow CLI handler (~line 361): `async (params, runtime, trace) =>` and pass trace to `wf.execute`

- [ ] **Step 8: Build to verify**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds

- [ ] **Step 9: Commit**

```bash
git add src/registry/codegen.ts
git commit -m "feat(trace): pass trace and toolName through codegen handler closures"
```

---

### Task 5: Twitter types cleanup

**Files:**
- Modify: `src/sites/twitter/types.ts:151-174`

- [ ] **Step 1: Remove FeedDebug interface and debug field from FeedResult**

In `src/sites/twitter/types.ts`, delete the `FeedDebug` section (lines 151-161):

```typescript
// --- FeedDebug ---

export interface FeedDebug {
  tabRequested: string;
  navAction: string;
  tabAction: string;
  reloadFallback: boolean;
  graphqlResponseCount: number;
  rawBeforeFilter: number;
  elapsedMs: number;
}
```

And remove `debug?: FeedDebug;` from the `FeedResult` interface (line 173).

- [ ] **Step 2: Build to verify**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/sites/twitter/types.ts
git commit -m "refactor(twitter): remove FeedDebug interface, debug field handled by trace"
```

---

### Task 6: Twitter workflows — add trace to getFeed

**Files:**
- Modify: `src/sites/twitter/workflows.ts`

- [ ] **Step 1: Add trace imports**

Add to imports in `src/sites/twitter/workflows.ts`:

```typescript
import { NOOP_TRACE, NOOP_SPAN, type Trace, type SpanHandle } from '../../trace.js';
```

- [ ] **Step 2: Add span param to ensureTimeline**

Change `ensureTimeline` signature from:

```typescript
export async function ensureTimeline(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { tab: TimelineFeed; t0: number },
): Promise<EnsureTimelineResult> {
```

to:

```typescript
export async function ensureTimeline(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { tab: TimelineFeed; t0: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsureTimelineResult> {
```

Wrap key steps inside ensureTimeline with `span.span()`:

Replace the body of ensureTimeline (from `const { tab, t0 } = opts;` to `return { navAction, tabAction, reloaded, waits };`) with:

```typescript
  const { tab, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  const ensure = makeEnsureState(primitives);

  // Step 1: Navigate to Twitter home
  const { action: navAction } = await span.span('navigate', async (s) => {
    const result = await ensure({ url: TWITTER_HOME });
    s.set('action', result.action);
    if (result.action === 'already_there') {
      await primitives.navigate(TWITTER_HOME);
    }
    return result;
  });

  // Step 2: Switch to target tab
  const tabName = tab === 'following' ? 'Following' : 'For you';
  const prevLength = collector.length;
  const { action: tabAction } = await span.span('switchTab', async (s) => {
    const result = await ensure({ role: 'tab', name: tabName, selected: true });
    s.set('action', result.action);
    s.set('tabName', tabName);
    if (result.action !== 'already_there') {
      const dataFromSwitch = collector.items.slice(prevLength);
      collector.clear();
      if (dataFromSwitch.length > 0) {
        collector.push(...dataFromSwitch);
      }
    }
    return result;
  });

  // Step 3: Wait for data
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData && !reloaded) {
      reloaded = true;
      collector.clear();
      await primitives.navigate(TWITTER_HOME);
      await ensure({ role: 'tab', name: tabName, selected: true });
      const hasDataAfterReload = await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', hasDataAfterReload);
      s.set('dataCountAfterReload', collector.length);
    }
  });

  return { navAction, tabAction, reloaded, waits };
```

- [ ] **Step 3: Add span param to collectData**

Change `collectData` signature from:

```typescript
export async function collectData(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { count: number; t0: number },
): Promise<CollectDataResult> {
```

to:

```typescript
export async function collectData(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { count: number; t0: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<CollectDataResult> {
```

Wrap each scroll round with a span. In the `while` loop, wrap the scroll + wait block:

Replace the while loop body with:

```typescript
    round++;
    const prevTotal = collector.length;

    await span.span(`scroll_${round}`, async (s) => {
      await primitives.scroll({ direction: 'down' });

      const startedAt = Date.now() - t0;
      const satisfied = await collector.waitUntil(() => collector.length > prevTotal, SCROLL_WAIT_MS);
      waits.push({
        round,
        purpose: `scroll_${round}`,
        startedAt,
        resolvedAt: Date.now() - t0,
        satisfied,
        dataCount: collector.length,
      });

      s.set('satisfied', satisfied);
      s.set('dataCount', collector.length);
      s.set('newItems', collector.length - prevTotal);

      if (satisfied) {
        staleRounds = 0;
      } else {
        staleRounds++;
      }
    });
```

- [ ] **Step 4: Rewrite getFeed to use trace**

Change `getFeed` signature from:

```typescript
export async function getFeed(
  primitives: Primitives,
  opts: GetFeedOptions = {},
): Promise<FrameworkFeedResult> {
```

to:

```typescript
export async function getFeed(
  primitives: Primitives,
  opts: GetFeedOptions = {},
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
```

Replace the body from `const { count = 20, ...` through the end of the function with:

```typescript
  const { count = 20, tab = 'for_you', dumpRaw } = opts;

  const t0 = Date.now();

  return await trace.span('getFeed', async (rootSpan) => {
    rootSpan.set('tab', tab);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

    const collector = createDataCollector<RawTweetData>();
    let dumpIndex = 0;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_TIMELINE_PATTERN,
      (response) => {
        try {
          if (dumpRaw) {
            fs.mkdirSync(dumpRaw, { recursive: true });
            const outPath = path.join(dumpRaw, `graphql-${dumpIndex++}.json`);
            fs.writeFileSync(outPath, response.body);
          }
          const parsed = parseGraphQLTimeline(response.body);
          collector.push(...parsed);
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch {
          graphqlFailures++;
          rootSpan.set('graphqlFailures', graphqlFailures);
        }
      },
    );

    try {
      await rootSpan.span('ensureTimeline', async (s) => {
        await ensureTimeline(primitives, collector, { tab, t0 }, s);
      });

      await rootSpan.span('collectData', async (s) => {
        await collectData(primitives, collector, { count, t0 }, s);
      });

      const tweets = [...collector.items]
        .map(parseTweet)
        .filter((t) => !t.isAd)
        .slice(0, count);

      const meta = buildFeedMeta(tweets);
      const items = tweets.map(tweetToFeedItem);

      rootSpan.set('rawBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);

      return {
        items,
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      cleanup();
    }
  });
```

- [ ] **Step 5: Build to verify**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/workflows.ts
git commit -m "feat(trace): add span instrumentation to getFeed, ensureTimeline, collectData"
```

---

### Task 7: Twitter workflows — add trace to getTweetDetail

**Files:**
- Modify: `src/sites/twitter/workflows.ts`

- [ ] **Step 1: Add span param to ensureTweetDetail**

Change `ensureTweetDetail` signature to add `span: SpanHandle = NOOP_SPAN` as last parameter.

Wrap key steps with `span.span()`:

```typescript
export async function ensureTweetDetail(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { url: string; t0: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsureTweetDetailResult> {
  const { url, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  // Step 1: Navigate to tweet detail page
  await span.span('navigate', async () => {
    await primitives.navigate(url);
  });

  // Step 2: Check for login redirect
  await span.span('checkLogin', async (s) => {
    const currentUrl = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', currentUrl);
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', { retryable: false });
    }
  });

  // Step 3: Wait for initial data
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData) {
      reloaded = true;
      collector.clear();
      await primitives.navigate(url);
      const hasDataAfterReload = await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', hasDataAfterReload);
      s.set('dataCountAfterReload', collector.length);
    }
  });

  return { reloaded, waits };
}
```

- [ ] **Step 2: Rewrite getTweetDetail to use trace**

Change `getTweetDetail` signature to add `trace: Trace = NOOP_TRACE` as last parameter.

Replace the body with trace-instrumented version (same pattern as getFeed):

```typescript
export async function getTweetDetail(
  primitives: Primitives,
  opts: GetTweetDetailOptions,
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
  const { url, count = 20, dumpRaw } = opts;
  const t0 = Date.now();

  return await trace.span('getTweetDetail', async (rootSpan) => {
    rootSpan.set('url', url);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

    let anchor: RawTweetData | null = null;
    let hasCursor = false;
    const collector = createDataCollector<RawTweetData>();
    let dumpIndex = 0;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_TWEET_DETAIL_PATTERN,
      (response) => {
        try {
          if (dumpRaw) {
            fs.mkdirSync(dumpRaw, { recursive: true });
            const outPath = path.join(dumpRaw, `tweet-detail-${dumpIndex++}.json`);
            fs.writeFileSync(outPath, response.body);
          }
          const parsed = parseTweetDetail(response.body);
          if (parsed.anchor && !anchor) {
            anchor = parsed.anchor;
          }
          hasCursor = parsed.hasCursor;
          if (parsed.replies.length > 0) {
            collector.push(...parsed.replies);
          }
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch {
          graphqlFailures++;
          rootSpan.set('graphqlFailures', graphqlFailures);
        }
      },
    );

    try {
      await rootSpan.span('ensureTweetDetail', async (s) => {
        await ensureTweetDetail(primitives, collector, { url, t0 }, s);
      });

      if (collector.length < count && hasCursor) {
        await rootSpan.span('collectData', async (s) => {
          await collectData(primitives, collector, { count, t0 }, s);
        });
      }

      const allRaw = anchor ? [anchor, ...collector.items] : [...collector.items];
      const tweets = allRaw
        .map(parseTweet)
        .filter((t) => !t.isAd);

      const anchorTweet = anchor ? tweets[0] : undefined;
      const replyTweets = anchor ? tweets.slice(1, count + 1) : tweets.slice(0, count);
      const finalTweets = anchorTweet ? [anchorTweet, ...replyTweets] : replyTweets;

      const meta = buildFeedMeta(finalTweets);
      const items = finalTweets.map(tweetToFeedItem);

      rootSpan.set('rawRepliesBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);
      rootSpan.set('hasAnchor', anchor !== null);

      return {
        items,
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      cleanup();
    }
  });
}
```

- [ ] **Step 3: Remove debug-related code**

In `GetFeedOptions` interface, remove `debug?: boolean` field.
In `GetTweetDetailOptions` interface, remove `debug?: boolean` field.

In `getFeed` function, the `debug` destructuring and `if (debug)` block are already gone from Task 6. Verify no remaining references.

In `getTweetDetail` function, the `debug` destructuring and `if (debug)` block are already replaced above. Verify no remaining references.

Run a quick search to confirm no leftover `debug` usage in workflows.ts:
Run: `grep -n "debug" src/sites/twitter/workflows.ts`
Expected: No matches (or only the word "debug" in unrelated comments).

- [ ] **Step 4: Build to verify**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/workflows.ts
git commit -m "feat(trace): add span instrumentation to getTweetDetail, ensureTweetDetail"
```

---

### Task 8: Update debug test

**Files:**
- Modify: `src/sites/twitter/__tests__/workflows.test.ts`

- [ ] **Step 1: Update the debug test to use trace**

Replace the test at lines 255-298 in `src/sites/twitter/__tests__/workflows.test.ts`. The test currently calls `getFeed(primitives, { debug: true, count: 0 })` and asserts on `result.debug`. Change it to:

```typescript
  it('records trace spans when Trace is provided', async () => {
    const { Trace } = await import('../../../trace.js');
    const { getFeed } = await import('../workflows.js');

    let interceptHandler: any;
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          interceptHandler = handler;
          return () => {};
        },
      ),
      navigate: vi.fn().mockImplementation(async () => {
        interceptHandler({
          url: '/i/api/graphql/abc/HomeLatestTimeline',
          status: 200,
          body: GRAPHQL_BODY,
        });
      }),
    });

    const trace = new Trace('twitter_feed');
    const result = await getFeed(primitives, { count: 0 }, trace);

    // Result should NOT have debug field
    expect(result).not.toHaveProperty('debug');

    // Trace should have span data
    const traceData = trace.toJSON();
    expect(traceData.tool).toBe('twitter_feed');
    expect(traceData.status).toBe('ok');
    expect(traceData.root.children).toHaveLength(1); // getFeed root span

    const getFeedSpan = traceData.root.children[0];
    expect(getFeedSpan.name).toBe('getFeed');
    expect(getFeedSpan.status).toBe('ok');
    expect(getFeedSpan.attrs.tab).toBe('for_you');

    // Should have ensureTimeline and collectData child spans
    const childNames = getFeedSpan.children.map((c: any) => c.name);
    expect(childNames).toContain('ensureTimeline');
    expect(childNames).toContain('collectData');

    // ensureTimeline should have fine-grained children
    const ensureSpan = getFeedSpan.children.find((c: any) => c.name === 'ensureTimeline');
    expect(ensureSpan).toBeDefined();
    const ensureChildNames = ensureSpan!.children.map((c: any) => c.name);
    expect(ensureChildNames).toContain('navigate');
    expect(ensureChildNames).toContain('switchTab');
    expect(ensureChildNames).toContain('waitForData');
  });
```

- [ ] **Step 2: Run all tests**

Run: `cd d:/src/zyb/site-use && pnpm run build && pnpm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/sites/twitter/__tests__/workflows.test.ts
git commit -m "test(trace): update debug test to verify trace span tree structure"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full build**

Run: `cd d:/src/zyb/site-use && pnpm run build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Full test suite**

Run: `cd d:/src/zyb/site-use && pnpm test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test — verify debug response format**

Run: `cd d:/src/zyb/site-use && node dist/cli/index.js twitter feed --count 5 --debug`
Expected: Output includes `{ "result": { "items": [...], "meta": {...} }, "trace": { "tool": "twitter_feed", "root": {...} } }`

- [ ] **Step 4: Commit all remaining changes**

If any files were missed, stage and commit them:

```bash
git add -A
git status
# Verify only expected files are staged
git commit -m "chore: final cleanup for request trace feature"
```
