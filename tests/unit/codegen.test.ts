import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateCliCommands } from '../../src/registry/codegen.js';
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
