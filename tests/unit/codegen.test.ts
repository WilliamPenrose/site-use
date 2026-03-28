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
    const plugin = fakePlugin();
    const tools = generateMcpTools([plugin], fakeManager());
    expect(tools).toHaveLength(0);
  });

  it('passes autoIngest to customWorkflow when storeAdapter is declared', () => {
    const plugin = fakePlugin({
      storeAdapter: {
        toIngestItems: (items) => items.map(i => ({
          site: 'testsite', id: i.id, text: i.text, author: 'a',
          timestamp: '2026-01-01T00:00:00Z', url: 'https://test.com/1',
          rawJson: JSON.stringify(i),
        })),
      },
      customWorkflows: [{
        name: 'search',
        description: 'Search testsite',
        params: z.object({ query: z.string() }),
        execute: async () => ({ items: [{ id: '1', text: 'result' }] }),
      }],
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const searchTool = tools.find(t => t.name === 'testsite_search');
    expect(searchTool).toBeDefined();
  });

  it('does not pass autoIngest to customWorkflow when storeAdapter is absent', () => {
    const plugin = fakePlugin({
      customWorkflows: [{
        name: 'search',
        description: 'Search testsite',
        params: z.object({ query: z.string() }),
        execute: async () => ({ items: [] }),
      }],
    });
    const tools = generateMcpTools([plugin], fakeManager());
    const searchTool = tools.find(t => t.name === 'testsite_search');
    expect(searchTool).toBeDefined();
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
      fakePlugin({ name: 'twitter', domains: ['x.com'], capabilities: { auth: { check: async () => ({ loggedIn: true }) } } }),
      fakePlugin({ name: 'reddit', domains: ['reddit.com'], capabilities: { auth: { check: async () => ({ loggedIn: true }) } } }),
    ], fakeManager());
    const sites = [...new Set(cmds.map(c => c.site))];
    expect(sites.sort()).toEqual(['reddit', 'twitter']);
  });
});

describe('generateCliCommands — smart cache', () => {
  it('generates feed command that accepts cache flags without error', () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({ tab: z.string().optional() }),
          localQuery: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          cache: { defaultMaxAge: 120, variantKey: 'tab', defaultVariant: 'for_you' },
        },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'feed');
    expect(entry).toBeDefined();
  });

  it('feed command without localQuery has no cache behavior', () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({ count: z.number().optional() }),
        },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'feed');
    expect(entry).toBeDefined();
  });

  it('feed command with cache handles --help', async () => {
    const plugin = fakePlugin({
      capabilities: {
        feed: {
          collect: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          params: z.object({ tab: z.string().optional() }),
          localQuery: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
          cache: { defaultMaxAge: 120 },
          cli: { description: 'Collect feed', help: 'Feed help text' },
        },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'feed')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry.handler(['--help']);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Feed help text');
    expect(output).toContain('--local');
    expect(output).toContain('--fetch');
    expect(output).toContain('--max-age');
    consoleSpy.mockRestore();
  });

  it('check-login command handles --help', async () => {
    const plugin = fakePlugin({
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }) },
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'check-login')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry.handler(['--help']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
