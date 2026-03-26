# Plan 3: Codegen — MCP Tool and CLI Auto-Generation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given an array of SitePlugin declarations, auto-generate MCP tool registrations and CLI command entries — zero manual registration per site.

**Architecture:** New `src/registry/codegen.ts` generates runtime objects (not code files). For MCP: produces `{ name, config, handler }` tuples that `server.registerTool()` consumes. For CLI: produces a dispatcher map `{ 'twitter feed': handler }` that `index.ts` consumes. The codegen wraps each handler with the framework's cross-cutting concerns (mutex, validation, error formatting, screenshot, circuit breaker).

**Tech Stack:** TypeScript, Zod, Vitest, @modelcontextprotocol/sdk

**Spec:** [M8 Multi-Site Plugin Architecture](./multi-site-plugin-architecture.md) — Section 4

**Depends on:** Plan 1 (registry types), Plan 2 (runtime)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/registry/codegen.ts` | Generate MCP tool definitions + CLI command entries from SitePlugin[] |
| Create | `src/registry/tool-wrapper.ts` | Framework cross-cutting wrapper (mutex, validation, errors, screenshot, circuit breaker) |
| Create | `src/registry/default-descriptions.ts` | Default MCP tool descriptions and error hints |
| Create | `tests/unit/codegen.test.ts` | Tool + CLI generation tests |
| Create | `tests/unit/tool-wrapper.test.ts` | Wrapper behavior tests |
| Modify | `src/registry/index.ts` | Add exports |

---

### Task 1: Default descriptions and error hints

**Files:**
- Create: `src/registry/default-descriptions.ts`

- [ ] **Step 1: Create the defaults module**

```ts
// src/registry/default-descriptions.ts

/** Default MCP tool descriptions for standard capabilities. */
export const DEFAULT_TOOL_DESCRIPTIONS: Record<string, (site: string) => string> = {
  auth: (site) => `Check if user is logged in to ${site}`,
  feed: (site) => `Collect feed items from ${site}`,
};

/** Default error hints, with {site} placeholder. */
export const DEFAULT_HINTS: Record<string, string> = {
  sessionExpired:
    'User is not logged in to {site}. Ask the user to log in manually in the browser, then retry.',
  rateLimited:
    'Rate limited by {site}. Do not retry immediately. Wait or switch to a different task, then retry later.',
  elementNotFound:
    'Expected UI element not found on {site}. The page may not have loaded fully, or the site\'s UI may have changed. Try taking a screenshot to diagnose.',
  navigationFailed:
    'Failed to navigate on {site}. Check if the site is accessible and the URL is correct. Try taking a screenshot to see the current page state.',
  stateTransitionFailed:
    'Action did not produce the expected result on {site}. Take a screenshot to see current state, then decide whether to retry or try an alternative approach.',
};

/** Resolve a hint for a given site and error type. Plugin hints take priority. */
export function resolveHint(
  pluginHints: Record<string, string> | undefined,
  errorType: string,
  siteName: string,
): string | undefined {
  // Plugin-provided hint
  const key = errorType.charAt(0).toLowerCase() + errorType.slice(1);
  const pluginHint = pluginHints?.[key];
  if (pluginHint) return pluginHint;

  // Framework default
  const defaultHint = DEFAULT_HINTS[key];
  if (defaultHint) return defaultHint.replace(/\{site\}/g, siteName);

  return undefined;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/registry/default-descriptions.ts
git commit -m "feat(codegen): default tool descriptions and error hints"
```

---

### Task 2: Tool wrapper (cross-cutting concerns)

**Files:**
- Create: `src/registry/tool-wrapper.ts`
- Create: `tests/unit/tool-wrapper.test.ts`

This wrapper implements the framework's tool-call pipeline from the design doc Section 4.2:
`get runtime → mutex → validate params → execute → validate result → error handling → screenshot → circuit breaker → format response`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/tool-wrapper.test.ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { wrapToolHandler } from '../../src/registry/tool-wrapper.js';
import type { SiteRuntime } from '../../src/runtime/types.js';
import { CircuitBreaker } from '../../src/runtime/circuit-breaker.js';
import { Mutex } from '../../src/mutex.js';
import { SessionExpired, RateLimited } from '../../src/errors.js';

function fakeRuntime(overrides: Partial<SiteRuntime> = {}): SiteRuntime {
  return {
    plugin: { apiVersion: 1, name: 'test', domains: ['test.com'] },
    primitives: {
      screenshot: vi.fn(async () => 'base64png'),
      navigate: vi.fn(),
      takeSnapshot: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn(),
      scrollIntoView: vi.fn(),
      evaluate: vi.fn(),
      interceptRequest: vi.fn(),
      getRawPage: vi.fn(),
    } as never,
    page: { isClosed: () => false, close: vi.fn() } as never,
    mutex: new Mutex(),
    circuitBreaker: new CircuitBreaker(5),
    ...overrides,
  };
}

describe('wrapToolHandler', () => {
  it('calls the handler and returns structured result', async () => {
    const handler = vi.fn(async () => ({ data: 'ok' }));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => fakeRuntime(),
    });

    const result = await wrapped({});
    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ data: 'ok' }),
    });
  });

  it('validates params with Zod schema when provided', async () => {
    const handler = vi.fn(async () => ({}));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => fakeRuntime(),
      paramsSchema: z.object({ count: z.number().min(1) }),
    });

    const result = await wrapped({ count: 0 });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('wraps SiteUseError with site field and hint', async () => {
    const runtime = fakeRuntime();
    runtime.plugin.hints = { sessionExpired: 'Log in to test please' };
    const handler = vi.fn(async () => { throw new SessionExpired('not logged in'); });
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('SessionExpired');
    expect(body.site).toBe('test');
    expect(body.context.hint).toBe('Log in to test please');
  });

  it('wraps unknown errors as PluginError', async () => {
    const handler = vi.fn(async () => { throw new TypeError('oops'); });
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => fakeRuntime(),
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('PluginError');
    expect(body.site).toBe('test');
  });

  it('records success on circuit breaker after successful call', async () => {
    const runtime = fakeRuntime();
    const spy = vi.spyOn(runtime.circuitBreaker, 'recordSuccess');
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler: async () => ({}),
      getRuntime: async () => runtime,
    });

    await wrapped({});
    expect(spy).toHaveBeenCalled();
  });

  it('records error on circuit breaker after failure', async () => {
    const runtime = fakeRuntime();
    const spy = vi.spyOn(runtime.circuitBreaker, 'recordError');
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler: async () => { throw new Error('fail'); },
      getRuntime: async () => runtime,
    });

    await wrapped({});
    expect(spy).toHaveBeenCalled();
  });

  it('returns circuit breaker error when tripped (open state, within cooldown)', async () => {
    const runtime = fakeRuntime();
    // Trip the breaker — enters open state
    for (let i = 0; i < 5; i++) runtime.circuitBreaker.recordError();
    expect(runtime.circuitBreaker.state).toBe('open');

    const handler = vi.fn(async () => ({}));
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('RateLimited');
  });

  it('captures auto-screenshot on SiteUseError', async () => {
    const runtime = fakeRuntime();
    const handler = async () => { throw new SessionExpired('test'); };
    const wrapped = wrapToolHandler({
      siteName: 'test',
      handler,
      getRuntime: async () => runtime,
    });

    const result = await wrapped({});
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.context.screenshotBase64).toBe('base64png');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/tool-wrapper.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement tool wrapper**

```ts
// src/registry/tool-wrapper.ts
import { z, type ZodType } from 'zod';
import type { SiteRuntime } from '../runtime/types.js';
import { SiteUseError, BrowserDisconnected, RateLimited } from '../errors.js';
import { resolveHint } from './default-descriptions.js';

const IngestItemSchema = z.object({
  site: z.string(), id: z.string(), text: z.string(), author: z.string(),
  timestamp: z.string(), url: z.string(), rawJson: z.string(),
  metrics: z.array(z.object({
    metric: z.string(), numValue: z.number().optional(),
    realValue: z.number().optional(), strValue: z.string().optional(),
  })).optional(),
  mentions: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
});

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface WrapOptions {
  siteName: string;
  handler: (params: Record<string, unknown>, runtime: SiteRuntime) => Promise<unknown>;
  getRuntime: () => Promise<SiteRuntime>;
  paramsSchema?: ZodType;
  resultSchema?: ZodType;
  /** Called on BrowserDisconnected to clear all runtimes. */
  onBrowserDisconnected?: () => void;
  /** If provided, framework auto-ingests after successful handler execution. */
  autoIngest?: {
    storeAdapter: { toIngestItems: (items: unknown[]) => unknown[] };
    siteName: string;
  };
}

export function wrapToolHandler(opts: WrapOptions): (params: Record<string, unknown>) => Promise<ToolResult> {
  return async (rawParams) => {
    // Get runtime (lazy creation)
    let runtime: SiteRuntime;
    try {
      runtime = await opts.getRuntime();
    } catch (err) {
      return formatError(opts.siteName, err as Error, undefined, opts.onBrowserDisconnected);
    }

    // Check circuit breaker before executing
    // Three-state model: isTripped = open state. half-open allows one probe.
    // No manual reset() — the breaker self-manages via cooldown.
    if (runtime.circuitBreaker.isTripped) {
      return formatError(
        opts.siteName,
        new RateLimited(
          `${runtime.circuitBreaker.streak || 5} consecutive operation failures on ${opts.siteName} — circuit breaker triggered. Wait before retrying.`,
        ),
        undefined,
      );
    }

    // Validate params
    if (opts.paramsSchema) {
      const parseResult = opts.paramsSchema.safeParse(rawParams);
      if (!parseResult.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            type: 'ValidationError',
            site: opts.siteName,
            message: `Invalid parameters: ${parseResult.error.message}`,
            issues: parseResult.error.issues,
          }) }],
          isError: true,
        };
      }
    }

    // Execute within mutex
    try {
      const result = await runtime.mutex.run(async () => {
        return await opts.handler(rawParams, runtime);
      });

      // Validate result (standard capabilities)
      if (opts.resultSchema) {
        const resultParse = opts.resultSchema.safeParse(result);
        if (!resultParse.success) {
          throw new SiteUseError('PluginError',
            `Plugin "${opts.siteName}" returned invalid result: ${resultParse.error.message}`,
            { retryable: false },
          );
        }
      }

      // Auto-ingest (feed → storeAdapter → store) — runs in Runtime layer, not Registry
      if (opts.autoIngest) {
        const feedResult = result as { items?: unknown[] };
        if (feedResult.items && feedResult.items.length > 0) {
          const { getStore } = await import('../storage/index.js');
          const store = getStore();
          const ingestItems = opts.autoIngest.storeAdapter
            .toIngestItems(feedResult.items)
            .map((item: Record<string, unknown>) => ({ ...item, site: opts.autoIngest!.siteName }));
          z.array(IngestItemSchema).parse(ingestItems);
          await store.ingest(ingestItems);
        }
      }

      runtime.circuitBreaker.recordSuccess();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      return formatError(opts.siteName, err as Error, runtime, opts.onBrowserDisconnected);
    }
  };
}

async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
): Promise<ToolResult> {
  if (err instanceof SiteUseError) {
    // Fix #2: BrowserDisconnected → clear all runtimes for reconnect
    if (err instanceof BrowserDisconnected && onBrowserDisconnected) {
      onBrowserDisconnected();
    }

    // Inject site field
    const context = { ...err.context, site: siteName };

    // Resolve hint
    const pluginHints = runtime?.plugin.hints;
    const hint = resolveHint(pluginHints as Record<string, string> | undefined, err.type, siteName);
    if (hint) context.hint = hint;

    // Auto-screenshot (except BrowserDisconnected)
    if (!(err instanceof BrowserDisconnected) && runtime) {
      try {
        context.screenshotBase64 = await runtime.primitives.screenshot();
      } catch {
        // screenshot failed, skip
      }
    }

    // Circuit breaker accounting (skip BrowserDisconnected and RateLimited)
    if (runtime && !(err instanceof BrowserDisconnected) && !(err instanceof RateLimited)) {
      runtime.circuitBreaker.recordError();
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        type: err.type,
        message: err.message,
        site: siteName,
        context,
      }) }],
      isError: true,
    };
  }

  // Unknown error → wrap as PluginError
  if (runtime) runtime.circuitBreaker.recordError();
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({
      type: 'PluginError',
      message: `Plugin "${siteName}" threw an unexpected error: ${err.message}`,
      site: siteName,
      context: { originalError: err.message, retryable: false },
    }) }],
    isError: true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/tool-wrapper.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/registry/tool-wrapper.ts tests/unit/tool-wrapper.test.ts
git commit -m "feat(codegen): tool wrapper with mutex, validation, circuit breaker, auto-screenshot"
```

---

### Task 3: MCP tool generation

**Files:**
- Create: `tests/unit/codegen.test.ts`
- Create: `src/registry/codegen.ts`
- Modify: `src/registry/index.ts`

- [ ] **Step 1: Write failing tests for MCP tool generation**

```ts
// tests/unit/codegen.test.ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateMcpTools, generateCliCommands } from '../../src/registry/codegen.js';
import type { SitePlugin } from '../../src/registry/types.js';
import type { SiteRuntimeManager } from '../../src/runtime/manager.js';

function fakePlugin(overrides: Partial<SitePlugin> = {}): SitePlugin {
  return {
    apiVersion: 1,
    name: 'testsite',
    domains: ['test.com'],
    ...overrides,
  };
}

function fakeManager(): SiteRuntimeManager {
  return { get: vi.fn() } as unknown as SiteRuntimeManager;
}

describe('generateMcpTools', () => {
  it('generates tool for auth capability', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }) },
      },
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const authTool = tools.find(t => t.name === 'testsite_check_login');
    expect(authTool).toBeDefined();
    expect(authTool!.config.description).toContain('testsite');
  });

  it('generates tool for feed capability with params schema', () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({ count: z.number() }),
        },
      },
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const feedTool = tools.find(t => t.name === 'testsite_feed');
    expect(feedTool).toBeDefined();
    expect(feedTool!.config.inputSchema).toBeDefined();
  });

  it('generates tool for custom workflow', () => {
    const plugin = fakePlugin({
      customWorkflows: [{
        name: 'trending',
        description: 'Get trending topics from testsite',
        params: z.object({ limit: z.number() }),
        execute: async () => ({}),
      }],
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const trendingTool = tools.find(t => t.name === 'testsite_trending');
    expect(trendingTool).toBeDefined();
    expect(trendingTool!.config.description).toBe('Get trending topics from testsite');
  });

  it('uses plugin description override over default', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => ({ loggedIn: true }),
          description: 'Custom auth check for testsite',
        },
      },
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const authTool = tools.find(t => t.name === 'testsite_check_login');
    expect(authTool!.config.description).toBe('Custom auth check for testsite');
  });

  it('respects expose: ["cli"] — skips MCP tool', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => ({ loggedIn: true }),
          expose: ['cli'],
        },
      },
    });
    const tools = generateMcpTools([plugin], fakeManager());
    expect(tools.find(t => t.name === 'testsite_check_login')).toBeUndefined();
  });

  it('generates tools for multiple plugins', () => {
    const twitter = fakePlugin({
      name: 'twitter',
      domains: ['x.com'],
      capabilities: { auth: { check: async () => ({ loggedIn: true }) } },
    });
    const reddit = fakePlugin({
      name: 'reddit',
      domains: ['reddit.com'],
      capabilities: { auth: { check: async () => ({ loggedIn: true }) } },
    });
    const tools = generateMcpTools([twitter, reddit], fakeManager());
    expect(tools.find(t => t.name === 'twitter_check_login')).toBeDefined();
    expect(tools.find(t => t.name === 'reddit_check_login')).toBeDefined();
  });

  it('skips capabilities not declared', () => {
    const plugin = fakePlugin(); // No capabilities
    const tools = generateMcpTools([plugin], fakeManager());
    expect(tools).toHaveLength(0);
  });
});

describe('generateCliCommands', () => {
  it('generates CLI entry for auth capability', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }) },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'check-login');
    expect(entry).toBeDefined();
  });

  it('generates CLI entry for feed capability', () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({ count: z.number() }),
        },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'feed');
    expect(entry).toBeDefined();
  });

  it('generates CLI entry for custom workflow', () => {
    const plugin = fakePlugin({
      customWorkflows: [{
        name: 'trending',
        description: 'Get trending',
        params: z.object({}),
        execute: async () => ({}),
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'trending');
    expect(entry).toBeDefined();
  });

  it('respects expose: ["mcp"] — skips CLI command', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => ({ loggedIn: true }),
          expose: ['mcp'],
        },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    expect(cmds.find(c => c.command === 'check-login')).toBeUndefined();
  });

  it('returns site names for help text generation', () => {
    const cmds = generateCliCommands([
      fakePlugin({ name: 'twitter', domains: ['x.com'] }),
      fakePlugin({ name: 'reddit', domains: ['reddit.com'] }),
    ], fakeManager());
    const sites = [...new Set(cmds.map(c => c.site))];
    expect(sites.sort()).toEqual(['reddit', 'twitter']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/unit/codegen.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement codegen**

```ts
// src/registry/codegen.ts
import { z, type ZodType, type ZodRawShape } from 'zod';
import type { SitePlugin, FeedResult } from './types.js';
import type { SiteRuntimeManager } from '../runtime/manager.js';
import { wrapToolHandler, type ToolResult } from './tool-wrapper.js';
import { DEFAULT_TOOL_DESCRIPTIONS } from './default-descriptions.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { getConfig } from '../config.js';
import path from 'node:path';

// ── FeedResult Zod schema for return value validation ──────────
const MediaItemSchema = z.object({
  type: z.string(), url: z.string(), width: z.number(), height: z.number(),
  duration: z.number().optional(), thumbnailUrl: z.string().optional(),
});
const FeedItemSchema = z.object({
  id: z.string(), author: z.object({ handle: z.string(), name: z.string() }),
  text: z.string(), timestamp: z.string(), url: z.string(),
  media: z.array(MediaItemSchema), links: z.array(z.string()),
  siteMeta: z.record(z.unknown()),
});
const FeedResultSchema = z.object({
  items: z.array(FeedItemSchema),
  meta: z.object({
    coveredUsers: z.array(z.string()),
    timeRange: z.object({ from: z.string(), to: z.string() }),
  }),
});

// IngestItem validation is in tool-wrapper.ts (Runtime layer, not Registry)

// ── MCP Tool generation ────────────────────────────────────────

export interface GeneratedMcpTool {
  name: string;
  config: {
    description: string;
    inputSchema?: ZodRawShape;
  };
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

function shouldExposeMcp(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true; // default: both
  return expose.includes('mcp');
}

function shouldExposeCli(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true;
  return expose.includes('cli');
}

export function generateMcpTools(
  plugins: SitePlugin[],
  runtimeManager: SiteRuntimeManager,
): GeneratedMcpTool[] {
  const tools: GeneratedMcpTool[] = [];

  for (const plugin of plugins) {
    const { capabilities, customWorkflows } = plugin;

    // Standard: auth
    if (capabilities?.auth && shouldExposeMcp(capabilities.auth.expose)) {
      const description = capabilities.auth.description
        ?? DEFAULT_TOOL_DESCRIPTIONS.auth(plugin.name);
      const authCheck = capabilities.auth.check;

      tools.push({
        name: `${plugin.name}_check_login`,
        config: { description },
        handler: wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          handler: async (_params, runtime) => {
            return await authCheck(runtime.primitives);
          },
        }),
      });
    }

    // Standard: feed
    if (capabilities?.feed && shouldExposeMcp(capabilities.feed.expose)) {
      const description = capabilities.feed.description
        ?? DEFAULT_TOOL_DESCRIPTIONS.feed(plugin.name);
      const feedCollect = capabilities.feed.collect;
      const paramsSchema = capabilities.feed.params;

      // Extract raw shape from Zod schema for MCP SDK
      const inputSchema = extractZodShape(paramsSchema);

      tools.push({
        name: `${plugin.name}_feed`,
        config: { description, inputSchema },
        handler: wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema,
          resultSchema: FeedResultSchema,  // ← Fix #1: validate FeedResult
          autoIngest: plugin.storeAdapter
            ? { storeAdapter: plugin.storeAdapter, siteName: plugin.name }
            : undefined,
          handler: async (params, runtime) => {
            const result = await feedCollect(runtime.primitives, params);

            // Record fetch timestamp (used by stats tool)
            const cfg = getConfig();
            const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
            const tab = (params as Record<string, unknown>).tab as string | undefined;
            setLastFetchTime(tsPath, plugin.name, tab ?? 'default');

            return result;
          },
        }),
      });
    }

    // Custom workflows
    if (customWorkflows) {
      for (const wf of customWorkflows) {
        if (!shouldExposeMcp(wf.expose)) continue;

        const inputSchema = extractZodShape(wf.params);

        tools.push({
          name: `${plugin.name}_${wf.name}`,
          config: { description: wf.description, inputSchema },
          handler: wrapToolHandler({
            siteName: plugin.name,
            getRuntime: () => runtimeManager.get(plugin.name),
            onBrowserDisconnected: () => runtimeManager.clearAll(),
            paramsSchema: wf.params,
            handler: async (params, runtime) => {
              return await wf.execute(runtime.primitives, params);
            },
          }),
        });
      }
    }
  }

  return tools;
}

/** Extract the raw shape from a ZodObject for MCP SDK's inputSchema. */
function extractZodShape(schema: ZodType): ZodRawShape | undefined {
  if (!schema) return undefined;
  // ZodObject has a .shape property
  if ('shape' in schema && typeof schema.shape === 'object') {
    return schema.shape as ZodRawShape;
  }
  // If it's not a ZodObject, return undefined (no inputSchema)
  return undefined;
}

// ── CLI command generation ─────────────────────────────────────

export interface GeneratedCliCommand {
  site: string;
  command: string;
  description: string;
  handler: (args: string[]) => Promise<void>;
}

export function generateCliCommands(
  plugins: SitePlugin[],
  runtimeManager: SiteRuntimeManager,
): GeneratedCliCommand[] {
  const commands: GeneratedCliCommand[] = [];

  for (const plugin of plugins) {
    const { capabilities, customWorkflows } = plugin;

    // CLI handlers reuse wrapToolHandler for consistent cross-cutting concerns
    // (circuit breaker, error handling, mutex). Output goes to stdout as JSON.

    // Standard: auth → check-login
    if (capabilities?.auth && shouldExposeCli(capabilities.auth.expose)) {
      const authCheck = capabilities.auth.check;
      const wrappedAuth = wrapToolHandler({
        siteName: plugin.name,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        handler: async (_params, runtime) => authCheck(runtime.primitives),
      });
      commands.push({
        site: plugin.name,
        command: 'check-login',
        description: capabilities.auth.cli?.description
          ?? `Check login status for ${plugin.name}`,
        handler: async () => {
          const result = await wrappedAuth({});
          const text = (result.content[0] as { text: string }).text;
          console.log(text);
          if (result.isError) process.exitCode = 1;
        },
      });
    }

    // Standard: feed
    if (capabilities?.feed && shouldExposeCli(capabilities.feed.expose)) {
      const feedCollect = capabilities.feed.collect;
      const paramsSchema = capabilities.feed.params;
      const wrappedFeed = wrapToolHandler({
        siteName: plugin.name,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        paramsSchema,
        resultSchema: FeedResultSchema,
        autoIngest: plugin.storeAdapter
          ? { storeAdapter: plugin.storeAdapter, siteName: plugin.name }
          : undefined,
        handler: async (params, runtime) => {
          const result = await feedCollect(runtime.primitives, params);
          const cfg = getConfig();
          const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
          const tab = (params as Record<string, unknown>).tab as string | undefined;
          setLastFetchTime(tsPath, plugin.name, tab ?? 'default');
          return result;
        },
      });
      commands.push({
        site: plugin.name,
        command: 'feed',
        description: capabilities.feed.cli?.description
          ?? `Collect feed from ${plugin.name}`,
        handler: async (args) => {
          const params = parseCliArgs(args, paramsSchema);
          const result = await wrappedFeed(params);
          const text = (result.content[0] as { text: string }).text;
          console.log(text);
          if (result.isError) process.exitCode = 1;
        },
      });
    }

    // Custom workflows
    if (customWorkflows) {
      for (const wf of customWorkflows) {
        if (!shouldExposeCli(wf.expose)) continue;
        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          handler: async (params, runtime) => wf.execute(runtime.primitives, params),
        });
        commands.push({
          site: plugin.name,
          command: wf.name,
          description: wf.cli?.description ?? wf.description,
          handler: async (args) => {
            const params = parseCliArgs(args, wf.params);
            const result = await wrappedWf(params);
            const text = (result.content[0] as { text: string }).text;
            console.log(text);
            if (result.isError) process.exitCode = 1;
          },
        });
      }
    }
  }

  return commands;
}

/**
 * Minimal CLI arg parser: converts --flag value pairs to object,
 * then validates against the Zod schema.
 */
function parseCliArgs(args: string[], schema: ZodType): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        raw[key] = true; // Boolean flag
        i++;
      } else {
        // Try to parse as number
        const num = Number(next);
        raw[key] = isNaN(num) ? next : num;
        i += 2;
      }
    } else {
      i++;
    }
  }
  return schema.parse(raw);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/codegen.test.ts`
Expected: all 12 tests PASS

- [ ] **Step 5: Export from index**

Add to `src/registry/index.ts`:

```ts
export { generateMcpTools, generateCliCommands } from './codegen.js';
export type { GeneratedMcpTool, GeneratedCliCommand } from './codegen.js';
export { wrapToolHandler } from './tool-wrapper.js';
export { resolveHint } from './default-descriptions.js';
```

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 7: Run all unit tests**

Run: `pnpm test tests/unit`
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add src/registry/codegen.ts src/registry/default-descriptions.ts src/registry/tool-wrapper.ts src/registry/index.ts tests/unit/codegen.test.ts tests/unit/tool-wrapper.test.ts
git commit -m "feat(codegen): auto-generate MCP tools and CLI commands from SitePlugin declarations"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] MCP tool naming: `{site}_{capability}` / `{site}_{workflow}` (Section 4.1) → Task 3
   - [x] Default descriptions with plugin override (Section 4.1) → Task 1 + Task 3
   - [x] Tool wrapper pipeline: runtime → circuit breaker check → validate params → mutex → execute → validate result → auto-ingest → error → screenshot → circuit breaker count (Section 4.2) → Task 2
   - [x] CLI naming: `site-use {site} {command}` (Section 4.3) → Task 3
   - [x] Expose control: `['mcp']`, `['cli']`, `['mcp', 'cli']` (Section 4.4) → Task 3 (tests cover all cases)
   - [x] Error hints: plugin → framework default (Section 5.3) → Task 1 (`resolveHint`)
   - [x] PluginError wrapping for unknown errors (Section 5.2) → Task 2
   - [x] Auto-screenshot on SiteUseError except BrowserDisconnected (Section 5.2) → Task 2
   - [x] Three-state circuit breaker: no manual reset, self-managed cooldown (Section 5.2) → Task 2
   - [x] FeedResult validation (QA review #1) → Task 2 (`resultSchema` option)
   - [x] Auto-ingest via storeAdapter after feed (Section 6.1) → Task 2 (`autoIngest` in tool-wrapper, Runtime layer)
   - [x] IngestItem Zod validation before ingest (Section 6.1) → Task 2 (tool-wrapper)
   - [x] Site field injection on IngestItem (Section 6.1) → Task 2 (tool-wrapper)
   - [x] CLI handlers reuse wrapToolHandler for consistent cross-cutting concerns → Task 3

2. **Placeholder scan:** No TBDs. All code blocks complete. `parseCliArgs` is minimal but functional — advanced CLI features (help text, examples) will be refined when server.ts/index.ts are refactored in Plan 5.

3. **Type consistency:** `GeneratedMcpTool`, `GeneratedCliCommand`, `wrapToolHandler`, `resolveHint`, `generateMcpTools`, `generateCliCommands` — consistent across tasks.
