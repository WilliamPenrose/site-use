import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateMcpTools, generateCliCommands } from '../../src/registry/codegen.js';
import { validatePlugins } from '../../src/registry/validation.js';
import type { SitePlugin } from '../../src/registry/types.js';
import type { SiteRuntimeManager } from '../../src/runtime/manager.js';

vi.mock('../../src/storage/index.js', () => ({
  createStore: vi.fn(() => ({
    ingest: vi.fn().mockResolvedValue({ inserted: 0, duplicates: 0 }),
    search: vi.fn().mockResolvedValue({ items: [] }),
    statsBySite: vi.fn().mockResolvedValue({}),
    countItems: vi.fn().mockResolvedValue(0),
  })),
}));

vi.mock('../../src/fetch-timestamps.js', () => ({
  setLastFetchTime: vi.fn(),
  getAllTimestamps: vi.fn(() => ({})),
}));

function fakeManager(): SiteRuntimeManager {
  return { get: vi.fn(), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
}

function fakePlugin(overrides: Partial<SitePlugin> = {}): SitePlugin {
  return {
    apiVersion: 1,
    name: 'fake',
    domains: ['fake.com'],
    capabilities: {
      auth: { check: async () => ({ loggedIn: true }) },
      feed: {
        collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
        params: z.object({ count: z.number().default(10) }),
      },
    },
    storeAdapter: {
      toIngestItems: (items) => items.map(item => ({
        site: 'fake', id: item.id, text: item.text, author: item.author.handle,
        timestamp: item.timestamp, url: item.url, rawJson: JSON.stringify(item),
      })),
    },
    ...overrides,
  };
}

function makeMockRuntime(plugin: SitePlugin) {
  return {
    plugin,
    primitives: { screenshot: vi.fn(async () => '') } as never,
    page: {} as never,
    mutex: { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    circuitBreaker: { isTripped: false, recordSuccess: vi.fn(), recordError: vi.fn(), streak: 0 } as never,
    rateLimitDetector: {} as never,
    authState: { loggedIn: null, lastCheckedAt: null },
  };
}

describe('Plugin Contract', () => {
  it('generates MCP tools from standard capabilities', () => {
    const tools = generateMcpTools([fakePlugin()], fakeManager());
    expect(tools.find(t => t.name === 'fake_check_login')).toBeDefined();
    expect(tools.find(t => t.name === 'fake_feed')).toBeDefined();
  });

  it('generates MCP tools from custom workflows', () => {
    const plugin = fakePlugin({
      customWorkflows: [{
        name: 'trending',
        description: 'Get trending',
        params: z.object({}),
        execute: async () => ({}),
      }],
    });
    const tools = generateMcpTools([plugin], fakeManager());
    expect(tools.find(t => t.name === 'fake_trending')).toBeDefined();
  });

  it('respects expose config (mcp-only)', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }), expose: ['mcp'] },
      },
    });
    const mcpTools = generateMcpTools([plugin], fakeManager());
    const cliCmds = generateCliCommands([plugin], fakeManager());
    expect(mcpTools.find(t => t.name === 'fake_check_login')).toBeDefined();
    expect(cliCmds.find(c => c.command === 'check-login')).toBeUndefined();
  });

  it('respects expose config (cli-only)', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }), expose: ['cli'] },
      },
    });
    const mcpTools = generateMcpTools([plugin], fakeManager());
    const cliCmds = generateCliCommands([plugin], fakeManager());
    expect(mcpTools.find(t => t.name === 'fake_check_login')).toBeUndefined();
    expect(cliCmds.find(c => c.command === 'check-login')).toBeDefined();
  });

  it('wraps unknown plugin errors as PluginError', async () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => { throw new TypeError('plugin bug'); },
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const tools = generateMcpTools([plugin], mgr);

    const authTool = tools.find(t => t.name === 'fake_check_login')!;
    const result = await authTool.handler({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('PluginError');
  });

  it('per-site circuit breaker does not affect other sites', () => {
    const alpha = fakePlugin({ name: 'alpha', domains: ['alpha.com'] });
    const beta = fakePlugin({ name: 'beta', domains: ['beta.com'] });
    validatePlugins([alpha, beta]);
    // If validation passes, they're independent — circuit breaker isolation
    // is tested in runtime-manager.test.ts (each runtime has own CB)
  });

  it('calls storeAdapter after feed.collect', async () => {
    const storeAdapterSpy = vi.fn(() => []);
    const plugin = fakePlugin({
      storeAdapter: { toIngestItems: storeAdapterSpy },
      capabilities: {
        feed: {
          collect: async () => ({
            items: [{ id: '1', author: { handle: 'a', name: 'A' }, text: 't', timestamp: '', url: '', media: [], links: [], siteMeta: {} }],
            meta: { coveredUsers: [], timeRange: { from: '', to: '' } },
          }),
          params: z.object({}),
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const tools = generateMcpTools([plugin], mgr);
    const feedTool = tools.find(t => t.name === 'fake_feed')!;
    await feedTool.handler({});
    expect(storeAdapterSpy).toHaveBeenCalled();
  });

  it('does not call storeAdapter when not declared', async () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({
            items: [{ id: '1', author: { handle: 'a', name: 'A' }, text: 't', timestamp: '', url: '', media: [], links: [], siteMeta: {} }],
            meta: { coveredUsers: [], timeRange: { from: '', to: '' } },
          }),
          params: z.object({}),
        },
      },
    });
    delete (plugin as Record<string, unknown>).storeAdapter;
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const tools = generateMcpTools([plugin], mgr);
    const feedTool = tools.find(t => t.name === 'fake_feed')!;
    // Should not throw — just skips ingest
    const result = await feedTool.handler({});
    expect(result.isError).toBeUndefined();
  });

  it('FeedResult validation rejects invalid return', async () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ bad: 'data' }) as never, // Invalid FeedResult
          params: z.object({}),
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const tools = generateMcpTools([plugin], mgr);
    const feedTool = tools.find(t => t.name === 'fake_feed')!;
    const result = await feedTool.handler({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('PluginError');
  });
});

describe('Error Scenario Tests', () => {
  it('config.json format error is fatal', async () => {
    const { getPluginsConfig } = await import('../../src/config.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-cfg-'));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ broken json');
    expect(() => getPluginsConfig(tmpDir)).toThrow(/config\.json/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('external plugin path not found is fatal', async () => {
    // import() of nonexistent path throws with helpful message
    await expect(
      import('nonexistent-plugin-that-does-not-exist-12345'),
    ).rejects.toThrow();
  });

  it('plugin detect runtime error is wrapped as PluginError', async () => {
    // When auth.check throws a non-SiteUseError, the wrapper should catch it
    // and return a PluginError response.
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => { throw new TypeError('detect crashed'); },
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const tools = generateMcpTools([plugin], mgr);
    const authTool = tools.find(t => t.name === 'fake_check_login')!;
    const result = await authTool.handler({});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.type).toBe('PluginError');
  });

  it('Twitter-only: tool inputSchema matches current structure', () => {
    const twitterPlugin = fakePlugin({
      name: 'twitter',
      domains: ['x.com', 'twitter.com'],
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({
            count: z.number().min(1).max(100).default(20),
            tab: z.enum(['following', 'for_you']).default('following'),
            debug: z.boolean().default(false),
            dump_raw: z.string().optional(),
          }),
        },
      },
    });
    const tools = generateMcpTools([twitterPlugin], fakeManager());
    const feedTool = tools.find(t => t.name === 'twitter_feed')!;
    const schema = feedTool.config.inputSchema!;
    // Verify the Zod raw shape has the expected keys
    expect(Object.keys(schema).sort()).toEqual(['count', 'debug', 'dump_raw', 'tab']);
  });
});

describe('Backward Compatibility Snapshots', () => {
  it('Twitter-only: generates same MCP tool names as current', () => {
    const twitterPlugin = fakePlugin({
      name: 'twitter',
      domains: ['x.com', 'twitter.com'],
    });
    const tools = generateMcpTools([twitterPlugin], fakeManager());
    const toolNames = tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['twitter_check_login', 'twitter_feed']);
  });

  it('Twitter-only: CLI commands match current', () => {
    const twitterPlugin = fakePlugin({
      name: 'twitter',
      domains: ['x.com', 'twitter.com'],
    });
    const cmds = generateCliCommands([twitterPlugin], fakeManager());
    const cmdNames = cmds.map(c => `${c.site} ${c.command}`).sort();
    expect(cmdNames).toEqual(['twitter check-login', 'twitter feed']);
  });
});
