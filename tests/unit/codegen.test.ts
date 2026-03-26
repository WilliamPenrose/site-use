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
