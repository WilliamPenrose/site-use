import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConfig } from '../../src/config.js';

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
});
