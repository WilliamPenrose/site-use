import { describe, it, expect, beforeEach } from 'vitest';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(name: string, domains: string[] = [`${name}.com`]): SitePlugin {
  return { apiVersion: 1, name, domains };
}

describe('mergePlugins', () => {
  let mergePlugins: typeof import('../../src/registry/discovery.js').mergePlugins;

  beforeEach(async () => {
    const mod = await import('../../src/registry/discovery.js');
    mergePlugins = mod.mergePlugins;
  });

  it('returns built-in plugins when no external plugins', () => {
    const builtins = [fakePlugin('twitter')];
    const result = mergePlugins(builtins, []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('twitter');
  });

  it('returns external plugins alongside built-ins', () => {
    const builtins = [fakePlugin('twitter')];
    const externals = [fakePlugin('reddit')];
    const result = mergePlugins(builtins, externals);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.name).sort()).toEqual(['reddit', 'twitter']);
  });

  it('external plugin overrides built-in with same name', () => {
    const builtinTwitter = fakePlugin('twitter', ['twitter.com']);
    const externalTwitter = fakePlugin('twitter', ['x.com', 'custom.com']);
    const result = mergePlugins([builtinTwitter], [externalTwitter]);
    expect(result).toHaveLength(1);
    expect(result[0].domains).toEqual(['x.com', 'custom.com']);
  });

  it('returns empty array when no plugins from either source', () => {
    const result = mergePlugins([], []);
    expect(result).toHaveLength(0);
  });

  it('preserves order: external first, then remaining built-ins', () => {
    const builtins = [fakePlugin('alpha'), fakePlugin('beta')];
    const externals = [fakePlugin('gamma')];
    const result = mergePlugins(builtins, externals);
    expect(result.map(p => p.name)).toEqual(['gamma', 'alpha', 'beta']);
  });
});
