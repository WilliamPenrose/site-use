import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteRuntimeManager } from '../../src/runtime/manager.js';
import type { SitePlugin } from '../../src/registry/types.js';

function fakePlugin(name: string): SitePlugin {
  return { apiVersion: 1, name, domains: [`${name}.com`] };
}

vi.mock('../../src/runtime/build-site-stack.js', () => ({
  buildSiteStack: vi.fn((_page: unknown, _plugin: SitePlugin) => ({
    primitives: { navigate: vi.fn(), takeSnapshot: vi.fn() } as never,
    rateLimitDetector: { signals: new Map(), checkAndThrow: vi.fn(), clear: vi.fn() } as never,
  })),
}));

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(async () => ({
    connected: true,
    newPage: vi.fn(async () => ({ isClosed: () => false, close: vi.fn(async () => {}) })),
    disconnect: vi.fn(),
  })),
}));

describe('SiteRuntimeManager', () => {
  let manager: SiteRuntimeManager;
  const plugins = [fakePlugin('twitter'), fakePlugin('reddit')];

  beforeEach(() => {
    manager = new SiteRuntimeManager(plugins);
  });

  it('creates runtime lazily on first get()', async () => {
    expect(manager.has('twitter')).toBe(false);
    const runtime = await manager.get('twitter');
    expect(runtime).toBeDefined();
    expect(runtime.plugin.name).toBe('twitter');
    expect(manager.has('twitter')).toBe(true);
  });

  it('returns cached runtime on subsequent get()', async () => {
    const first = await manager.get('twitter');
    const second = await manager.get('twitter');
    expect(first).toBe(second);
  });

  it('creates separate runtimes for different sites', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter).not.toBe(reddit);
    expect(twitter.plugin.name).toBe('twitter');
    expect(reddit.plugin.name).toBe('reddit');
  });

  it('throws for unknown site name', async () => {
    await expect(manager.get('nonexistent')).rejects.toThrow(/nonexistent/);
  });

  it('clear() removes a specific site runtime', async () => {
    await manager.get('twitter');
    expect(manager.has('twitter')).toBe(true);
    manager.clear('twitter');
    expect(manager.has('twitter')).toBe(false);
  });

  it('clearAll() removes all runtimes', async () => {
    await manager.get('twitter');
    await manager.get('reddit');
    manager.clearAll();
    expect(manager.has('twitter')).toBe(false);
    expect(manager.has('reddit')).toBe(false);
  });

  it('recreates runtime after clear()', async () => {
    const first = await manager.get('twitter');
    manager.clear('twitter');
    const second = await manager.get('twitter');
    expect(second).not.toBe(first);
  });

  it('each runtime has its own mutex', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.mutex).not.toBe(reddit.mutex);
  });

  it('each runtime has its own circuit breaker', async () => {
    const twitter = await manager.get('twitter');
    const reddit = await manager.get('reddit');
    expect(twitter.circuitBreaker).not.toBe(reddit.circuitBreaker);
  });

  it('concurrent get() for same site returns same runtime (no duplicate creation)', async () => {
    const [a, b] = await Promise.all([
      manager.get('twitter'),
      manager.get('twitter'),
    ]);
    expect(a).toBe(b);
  });
});
