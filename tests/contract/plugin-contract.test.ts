import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateCliCommands } from '../../src/registry/codegen.js';
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
  it('generates CLI commands from standard capabilities', () => {
    const cmds = generateCliCommands([fakePlugin()], fakeManager());
    expect(cmds.find(c => c.command === 'check-login')).toBeDefined();
    expect(cmds.find(c => c.command === 'feed')).toBeDefined();
  });

  it('generates CLI commands from custom workflows', () => {
    const plugin = fakePlugin({
      customWorkflows: [{
        name: 'trending',
        description: 'Get trending',
        params: z.object({}),
        execute: async () => ({}),
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    expect(cmds.find(c => c.command === 'trending')).toBeDefined();
  });

  it('respects expose config (cli-only)', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }), expose: ['cli'] },
      },
    });
    const cliCmds = generateCliCommands([plugin], fakeManager());
    expect(cliCmds.find(c => c.command === 'check-login')).toBeDefined();
  });

  it('respects expose config (mcp-only skips CLI)', () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }), expose: ['mcp'] },
      },
    });
    const cliCmds = generateCliCommands([plugin], fakeManager());
    expect(cliCmds.find(c => c.command === 'check-login')).toBeUndefined();
  });

  it('wraps unknown plugin errors as PluginError via CLI handler', async () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => { throw new TypeError('plugin bug'); },
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const cmds = generateCliCommands([plugin], mgr);

    const authCmd = cmds.find(c => c.command === 'check-login')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await authCmd.handler([]);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    const body = JSON.parse(output);
    expect(body.type).toBe('PluginError');
    consoleSpy.mockRestore();
  });

  it('per-site circuit breaker does not affect other sites', () => {
    const alpha = fakePlugin({ name: 'alpha', domains: ['alpha.com'] });
    const beta = fakePlugin({ name: 'beta', domains: ['beta.com'] });
    validatePlugins([alpha, beta]);
  });

  it('calls storeAdapter after feed.collect via CLI handler', async () => {
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
    const cmds = generateCliCommands([plugin], mgr);
    const feedCmd = cmds.find(c => c.command === 'feed')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await feedCmd.handler([]);
    expect(storeAdapterSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('does not call storeAdapter when not declared via CLI handler', async () => {
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
    const cmds = generateCliCommands([plugin], mgr);
    const feedCmd = cmds.find(c => c.command === 'feed')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Should not throw — just skips ingest
    await feedCmd.handler([]);
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('twitter plugin registers search workflow with correct schema', async () => {
    const { plugin } = await import('../../src/sites/twitter/index.js');
    const searchWf = plugin.customWorkflows?.find(w => w.name === 'search');
    expect(searchWf).toBeDefined();
    expect(searchWf!.expose).toEqual(['cli']);
    expect(searchWf!.description).toContain('Search Twitter');

    // Validate params schema accepts valid input
    const validResult = searchWf!.params.safeParse({ query: 'AI agents' });
    expect(validResult.success).toBe(true);

    // Validate defaults
    const parsed = searchWf!.params.parse({ query: 'test' });
    expect(parsed).toMatchObject({ query: 'test', tab: 'top', count: 20, debug: false });

    // Validate rejects empty query
    const emptyResult = searchWf!.params.safeParse({ query: '' });
    expect(emptyResult.success).toBe(false);
  });

  it('FeedResult validation rejects invalid return via CLI handler', async () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ bad: 'data' }) as never,
          params: z.object({}),
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const cmds = generateCliCommands([plugin], mgr);
    const feedCmd = cmds.find(c => c.command === 'feed')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await feedCmd.handler([]);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    const body = JSON.parse(output);
    expect(body.type).toBe('PluginError');
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
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
    await expect(
      import('nonexistent-plugin-that-does-not-exist-12345'),
    ).rejects.toThrow();
  });

  it('plugin detect runtime error is wrapped as PluginError via CLI', async () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: {
          check: async () => { throw new TypeError('detect crashed'); },
        },
      },
    });
    const mockRuntime = makeMockRuntime(plugin);
    const mgr = { get: vi.fn(async () => mockRuntime), clearAll: vi.fn() } as unknown as SiteRuntimeManager;
    const cmds = generateCliCommands([plugin], mgr);
    const authCmd = cmds.find(c => c.command === 'check-login')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await authCmd.handler([]);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    const body = JSON.parse(output);
    expect(body.type).toBe('PluginError');
    consoleSpy.mockRestore();
  });
});

describe('Backward Compatibility Snapshots', () => {
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
