import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConfig, getScrollEnhancementConfig } from '../../src/config.js';

describe('getConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns default data directory when SITE_USE_DATA_DIR is not set', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '');
    const config = getConfig();
    expect(config.dataDir).toMatch(/[/\\]\.site-use$/);
  });

  it('uses SITE_USE_DATA_DIR when set', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '/custom/data');
    const config = getConfig();
    expect(config.dataDir).toBe('/custom/data');
  });

  it('derives chromeProfileDir from dataDir', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '/custom/data');
    const config = getConfig();
    expect(config.chromeProfileDir).toMatch(/[/\\]chrome-profile$/);
    expect(config.chromeProfileDir).toContain('custom');
    expect(config.chromeProfileDir).toContain('data');
  });

  it('returns no proxy when SITE_USE_PROXY is not set', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('HTTP_PROXY', '');
    const config = getConfig();
    expect(config.proxy).toBeUndefined();
  });

  it('parses proxy config from environment variables', () => {
    vi.stubEnv('SITE_USE_PROXY', 'http://127.0.0.1:7890');
    vi.stubEnv('SITE_USE_PROXY_USER', 'user');
    vi.stubEnv('SITE_USE_PROXY_PASS', 'pass');
    const config = getConfig();
    expect(config.proxy).toEqual({
      server: 'http://127.0.0.1:7890',
      username: 'user',
      password: 'pass',
    });
  });

  it('returns proxy without auth when only SITE_USE_PROXY is set', () => {
    vi.stubEnv('SITE_USE_PROXY', 'socks5://127.0.0.1:1080');
    vi.stubEnv('SITE_USE_PROXY_USER', '');
    vi.stubEnv('SITE_USE_PROXY_PASS', '');
    const config = getConfig();
    expect(config.proxy).toEqual({
      server: 'socks5://127.0.0.1:1080',
    });
  });

  it('falls back to HTTPS_PROXY when SITE_USE_PROXY is not set', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', 'http://fallback:8080');
    vi.stubEnv('HTTP_PROXY', '');
    const config = getConfig();
    expect(config.proxy).toEqual({ server: 'http://fallback:8080' });
    expect(config.proxySource).toBe('HTTPS_PROXY');
  });

  it('falls back to HTTP_PROXY when SITE_USE_PROXY and HTTPS_PROXY are not set', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('HTTP_PROXY', 'http://httpfallback:3128');
    const config = getConfig();
    expect(config.proxy).toEqual({ server: 'http://httpfallback:3128' });
    expect(config.proxySource).toBe('HTTP_PROXY');
  });

  it('prefers SITE_USE_PROXY over HTTPS_PROXY', () => {
    vi.stubEnv('SITE_USE_PROXY', 'socks5://preferred:1080');
    vi.stubEnv('HTTPS_PROXY', 'http://fallback:8080');
    const config = getConfig();
    expect(config.proxy?.server).toBe('socks5://preferred:1080');
    expect(config.proxySource).toBe('SITE_USE_PROXY');
  });

  it('sets proxySource to undefined when no proxy configured', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('HTTP_PROXY', '');
    const config = getConfig();
    expect(config.proxy).toBeUndefined();
    expect(config.proxySource).toBeUndefined();
  });

  it('applies SITE_USE_PROXY_USER/PASS credentials to fallback proxy', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', 'http://fallback:8080');
    vi.stubEnv('SITE_USE_PROXY_USER', 'user');
    vi.stubEnv('SITE_USE_PROXY_PASS', 'pass');
    const config = getConfig();
    expect(config.proxy).toEqual({
      server: 'http://fallback:8080',
      username: 'user',
      password: 'pass',
    });
    expect(config.proxySource).toBe('HTTPS_PROXY');
  });
});

describe('getScrollEnhancementConfig', () => {
  it('returns humanize enabled by default', () => {
    const config = getScrollEnhancementConfig();
    expect(config.humanize).toBe(true);
  });

  it('respects SITE_USE_SCROLL_HUMANIZE=false', () => {
    process.env.SITE_USE_SCROLL_HUMANIZE = 'false';
    try {
      const config = getScrollEnhancementConfig();
      expect(config.humanize).toBe(false);
    } finally {
      delete process.env.SITE_USE_SCROLL_HUMANIZE;
    }
  });
});
