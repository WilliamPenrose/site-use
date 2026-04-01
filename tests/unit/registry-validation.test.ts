import { describe, it, expect } from 'vitest';
import { validatePlugins } from '../../src/registry/validation.js';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(overrides: Partial<SitePlugin> = {}): SitePlugin {
  return {
    apiVersion: 1,
    name: 'fake',
    domains: ['fake.com'],
    ...overrides,
  };
}

describe('validatePlugins', () => {
  it('accepts a valid minimal plugin', () => {
    expect(() => validatePlugins([fakePlugin()])).not.toThrow();
  });

  it('accepts a plugin with all optional fields', () => {
    const plugin = fakePlugin({
      detect: () => null,
      capabilities: {
        auth: { check: async () => ({ loggedIn: true }) },
      },
      hints: { rateLimited: 'Wait and retry' },
    });
    expect(() => validatePlugins([plugin])).not.toThrow();
  });

  it('rejects plugin missing name', () => {
    const plugin = { apiVersion: 1, domains: ['x.com'] } as unknown as SitePlugin;
    expect(() => validatePlugins([plugin])).toThrow(/name/i);
  });

  it('rejects plugin with empty domains', () => {
    const plugin = fakePlugin({ domains: [] });
    expect(() => validatePlugins([plugin])).toThrow(/domains/i);
  });

  it('rejects plugin with wrong apiVersion', () => {
    const plugin = fakePlugin({ apiVersion: 2 as never });
    expect(() => validatePlugins([plugin])).toThrow(/apiVersion/i);
  });

  it('rejects plugin with reserved name "browser"', () => {
    const plugin = fakePlugin({ name: 'browser' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects plugin with reserved name "search"', () => {
    const plugin = fakePlugin({ name: 'search' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects plugin with reserved name "mcp"', () => {
    const plugin = fakePlugin({ name: 'mcp' });
    expect(() => validatePlugins([plugin])).toThrow(/reserved/i);
  });

  it('rejects duplicate plugin names', () => {
    const a = fakePlugin({ name: 'dup' });
    const b = fakePlugin({ name: 'dup', domains: ['other.com'] });
    expect(() => validatePlugins([a, b])).toThrow(/duplicate/i);
  });

  it('allows multiple plugins with different names', () => {
    const a = fakePlugin({ name: 'alpha', domains: ['alpha.com'] });
    const b = fakePlugin({ name: 'beta', domains: ['beta.com'] });
    expect(() => validatePlugins([a, b])).not.toThrow();
  });

  it('allows multiple plugins with overlapping domains', () => {
    const a = fakePlugin({ name: 'alpha', domains: ['shared.com'] });
    const b = fakePlugin({ name: 'beta', domains: ['shared.com'] });
    expect(() => validatePlugins([a, b])).not.toThrow();
  });
});
