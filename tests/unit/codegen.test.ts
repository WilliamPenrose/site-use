import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateCliCommands } from '../../src/registry/codegen.js';
import type { SitePlugin, QueryWorkflow } from '../../src/registry/types.js';
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
      auth: { check: async () => ({ loggedIn: true }) },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'check-login');
    expect(entry).toBeDefined();
  });

  it('generates CLI entry for workflow with cache', () => {
    const plugin = fakePlugin({
      workflows: [{
        kind: 'collection' as const,
        name: 'feed',
        description: 'Collect feed',
        execute: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
        params: z.object({ count: z.number().optional() }),
        cache: { defaultMaxAge: 120 },
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'feed');
    expect(entry).toBeDefined();
  });

  it('generates CLI entry for workflow without cache', () => {
    const plugin = fakePlugin({
      workflows: [{
        kind: 'collection' as const,
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
      auth: {
        check: async () => ({ loggedIn: true }),
        expose: ['mcp'],
      },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    expect(cmds.find(c => c.command === 'check-login')).toBeUndefined();
  });

  it('returns site names for help text generation', () => {
    const cmds = generateCliCommands([
      fakePlugin({ name: 'twitter', domains: ['x.com'], auth: { check: async () => ({ loggedIn: true }) } }),
      fakePlugin({ name: 'reddit', domains: ['reddit.com'], auth: { check: async () => ({ loggedIn: true }) } }),
    ], fakeManager());
    const sites = [...new Set(cmds.map(c => c.site))];
    expect(sites.sort()).toEqual(['reddit', 'twitter']);
  });
});

describe('generateCliCommands — help', () => {
  it('collection workflow --help shows output options', async () => {
    const plugin = fakePlugin({
      workflows: [{
        kind: 'collection' as const,
        name: 'feed',
        description: 'Collect feed',
        execute: async () => ({ items: [], meta: { coveredUsers: [], timeRange: { from: '', to: '' } } }),
        params: z.object({ tab: z.string().optional() }),
        cli: { description: 'Collect feed', help: 'Feed help text' },
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'feed')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry.handler(['--help']);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Feed help text');
    expect(output).toContain('--stdout');
    expect(output).toContain('--output');
    consoleSpy.mockRestore();
  });

  it('check-login command handles --help', async () => {
    const plugin = fakePlugin({
      auth: { check: async () => ({ loggedIn: true }) },
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'check-login')!;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry.handler(['--help']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('generateCliCommands — query workflow', () => {
  it('generates CLI entry for query workflow', () => {
    const plugin = fakePlugin({
      workflows: [{
        kind: 'query' as const,
        name: 'profile',
        description: 'View profile',
        params: z.object({ handle: z.string().optional() }),
        execute: async () => ({ user: {}, relationship: null }),
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.site === 'testsite' && c.command === 'profile');
    expect(entry).toBeDefined();
    expect(entry!.description).toBe('View profile');
  });

  it('query workflow handler outputs direct JSON, not formatCliOutput', async () => {
    const queryResult = { user: { handle: 'test' }, relationship: null };
    const mockRuntime = {
      primitives: {},
      mutex: { run: (fn: any) => fn() },
      plugin: { apiVersion: 1, name: 'testsite', domains: [] },
      circuitBreaker: { isTripped: false, streak: 0, recordSuccess: vi.fn(), recordError: vi.fn() },
    };
    const plugin = fakePlugin({
      workflows: [{
        kind: 'query' as const,
        name: 'profile',
        description: 'View profile',
        params: z.object({ handle: z.string().optional() }),
        execute: async () => queryResult,
      }],
    });
    const manager = { get: vi.fn().mockResolvedValue(mockRuntime) } as unknown as SiteRuntimeManager;
    const cmds = generateCliCommands([plugin], manager);
    const entry = cmds.find(c => c.command === 'profile');
    expect(entry).toBeDefined();

    // Call handler — should go through JSON path, not collection pipeline
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry!.handler(['--handle', 'test']);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('');
    consoleSpy.mockRestore();

    // Verify direct JSON output (not formatCliOutput which adds source/ageMinutes metadata)
    const parsed = JSON.parse(output);
    expect(parsed.user.handle).toBe('test');
    expect(parsed.relationship).toBeNull();
  });

  it('query workflow help does NOT show cache/fields options', async () => {
    const plugin = fakePlugin({
      workflows: [{
        kind: 'query' as const,
        name: 'profile',
        description: 'View profile',
        params: z.object({}),
        execute: async () => ({}),
        cli: { description: 'View profile', help: 'Options:\n  --handle <user>' },
      }],
    });
    const cmds = generateCliCommands([plugin], fakeManager());
    const entry = cmds.find(c => c.command === 'profile');
    expect(entry).toBeDefined();
    // Trigger help output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await entry!.handler(['--help']);
    const helpText = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    consoleSpy.mockRestore();
    // Should NOT contain cache options
    expect(helpText).not.toContain('--local');
    expect(helpText).not.toContain('--fetch');
    expect(helpText).not.toContain('--fields');
    expect(helpText).not.toContain('--quiet');
  });
});
