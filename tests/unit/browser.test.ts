import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

// In-memory store for chrome.json written by launchAndDetach
let chromeJsonStore: Record<string, string> = {};

// Mock puppeteer-core before importing browser module
const mockPage = { url: () => 'about:blank', close: vi.fn(), goto: vi.fn(), authenticate: vi.fn() };
const mockTarget = { type: () => 'page', url: () => 'about:blank', page: vi.fn().mockResolvedValue(mockPage) };
const mockCdpSession = { send: vi.fn().mockResolvedValue({}), detach: vi.fn().mockResolvedValue(undefined) };
const mockBrowser = {
  connected: true,
  on: vi.fn(),
  process: () => ({ pid: 12345 }),
  wsEndpoint: () => 'ws://127.0.0.1:9222/devtools/browser/mock',
  pages: vi.fn().mockResolvedValue([mockPage]),
  targets: vi.fn().mockReturnValue([mockTarget]),
  target: () => ({ createCDPSession: vi.fn().mockResolvedValue(mockCdpSession) }),
  disconnect: vi.fn(),
  close: vi.fn(),
};

const mockConnectedBrowser = {
  connected: true,
  on: vi.fn(),
  process: () => ({ pid: 12345 }),
  wsEndpoint: () => 'ws://127.0.0.1:9222/devtools/browser/mock',
  pages: vi.fn().mockResolvedValue([mockPage]),
  targets: vi.fn().mockReturnValue([mockTarget]),
  target: () => ({ createCDPSession: vi.fn().mockResolvedValue(mockCdpSession) }),
  disconnect: vi.fn(),
  close: vi.fn(),
};

const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);
const mockConnect = vi.fn().mockResolvedValue(mockConnectedBrowser);

vi.mock('puppeteer-core', () => ({
  default: { launch: mockLaunch, connect: mockConnect },
}));

// Mock child_process.spawn for launchAndDetach
const mockSpawnProcess = {
  pid: 12345,
  unref: vi.fn(),
};
const mockSpawn = vi.fn().mockReturnValue(mockSpawnProcess);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((filePath: string, _encoding?: string) => {
      // Check chrome.json store
      if (typeof filePath === 'string' && filePath.endsWith('chrome.json') && chromeJsonStore[filePath]) {
        return chromeJsonStore[filePath];
      }
      // DevToolsActivePort — return mock port info
      if (typeof filePath === 'string' && filePath.endsWith('DevToolsActivePort')) {
        return '9222\n/devtools/browser/mock\n';
      }
      throw new Error('ENOENT');
    }),
    writeFileSync: vi.fn((filePath: string, data: string) => {
      if (typeof filePath === 'string' && filePath.endsWith('chrome.json')) {
        chromeJsonStore[filePath] = data;
      }
    }),
    unlinkSync: vi.fn((filePath: string) => {
      if (typeof filePath === 'string') {
        delete chromeJsonStore[filePath];
      }
    }),
    existsSync: vi.fn((filePath: string) => {
      // Chrome executable path — pretend it exists
      if (typeof filePath === 'string' && filePath.includes('chrome')) return true;
      return false;
    }),
    mkdirSync: vi.fn(),
  };
});

// Mutable config for per-test overrides
let testConfig = {
  dataDir: '/tmp/test-site-use',
  chromeProfileDir: '/tmp/test-site-use/chrome-profile',
  chromeJsonPath: '/tmp/test-site-use/chrome.json',
  webrtcPolicy: 'disable_non_proxied_udp' as const,
  proxy: undefined as
    | { server: string; username?: string; password?: string }
    | undefined,
  proxySource: undefined as string | undefined,
};

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => testConfig),
  getClickEnhancementConfig: vi.fn(() => ({
    trajectory: false,
    jitter: false,
    occlusionCheck: false,
  })),
}));

vi.mock('../../src/browser/welcome.js', () => ({
  buildWelcomeHTML: () => '<html>welcome</html>',
}));

vi.mock('../../src/lock.js', () => ({
  isPidAlive: vi.fn((pid: number) => {
    // Only current process PID is "alive" in tests
    return pid === 12345 || pid === process.pid;
  }),
}));

// Import after mocks
const { ensureBrowser, closeBrowser, isBrowserConnected } = await import(
  '../../src/browser/browser.js'
);

// Default fs mock implementations — restore in beforeEach after any per-test overrides
const defaultReadFileSync = (filePath: string, _encoding?: string) => {
  if (typeof filePath === 'string' && filePath.endsWith('chrome.json') && chromeJsonStore[filePath]) {
    return chromeJsonStore[filePath];
  }
  if (typeof filePath === 'string' && filePath.endsWith('DevToolsActivePort')) {
    return '9222\n/devtools/browser/mock\n';
  }
  throw new Error('ENOENT');
};
const defaultWriteFileSync = (filePath: string, data: string) => {
  if (typeof filePath === 'string' && filePath.endsWith('chrome.json')) {
    chromeJsonStore[filePath] = data;
  }
};
const defaultExistsSync = (filePath: string) => {
  if (typeof filePath === 'string' && filePath.includes('chrome')) return true;
  return false;
};

describe('browser', () => {
  beforeEach(async () => {
    await closeBrowser();
    chromeJsonStore = {};
    mockLaunch.mockClear();
    mockLaunch.mockResolvedValue(mockBrowser);
    mockConnect.mockClear();
    mockConnect.mockResolvedValue(mockConnectedBrowser);
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue(mockSpawnProcess);
    mockSpawnProcess.unref.mockClear();
    mockBrowser.on.mockClear();
    mockBrowser.connected = true;
    mockBrowser.disconnect.mockClear();
    mockConnectedBrowser.on.mockClear();
    mockConnectedBrowser.connected = true;
    mockConnectedBrowser.close.mockClear();
    // Restore default fs mock implementations
    vi.mocked(readFileSync).mockImplementation(defaultReadFileSync as any);
    vi.mocked(writeFileSync).mockImplementation(defaultWriteFileSync as any);
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation(defaultExistsSync as any);
    testConfig = {
      dataDir: '/tmp/test-site-use',
      chromeProfileDir: '/tmp/test-site-use/chrome-profile',
      chromeJsonPath: '/tmp/test-site-use/chrome.json',
      webrtcPolicy: 'disable_non_proxied_udp' as const,
      proxy: undefined,
      proxySource: undefined,
    };
  });

  describe('ensureBrowser', () => {
    it('launches Chrome via launchAndDetach then connects when autoLaunch=true', async () => {
      const browser = await ensureBrowser({ autoLaunch: true });
      expect(browser).toBe(mockConnectedBrowser);
      // launchAndDetach uses spawn (not puppeteer.launch) then puppeteer.connect
      expect(mockSpawn).toHaveBeenCalledOnce();
      // ensureBrowser connects after launchAndDetach writes chrome.json
      expect(mockConnect).toHaveBeenCalled();
    });

    it('passes correct Chrome launch args to spawn', async () => {
      await ensureBrowser({ autoLaunch: true });
      const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(
        spawnArgs.some((a: string) => a.startsWith('--user-data-dir=')),
      ).toBe(true);
      expect(spawnArgs).toContain('--remote-debugging-port=0');
      expect(spawnArgs).toContain('--no-first-run');
      expect(spawnArgs).toContain('--no-default-browser-check');
      expect(spawnArgs).toContain('--disable-blink-features=AutomationControlled');
      expect(spawnArgs).toContain('--window-size=1920,1080');
      expect(spawnArgs).toContain('--lang=en-US');
      expect(spawnArgs).toContain('--accept-lang=en-US,en');
      expect(spawnArgs).toContain('--restore-last-session');
      expect(spawnArgs).toContain('--hide-crash-restore-bubble');
    });

    it('spawns Chrome with detached:true and stdio:ignore', async () => {
      await ensureBrowser({ autoLaunch: true });
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.stdio).toBe('ignore');
    });

    it('does not include --proxy-server when no proxy configured', async () => {
      await ensureBrowser({ autoLaunch: true });
      const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(
        spawnArgs.some((a: string) => a.startsWith('--proxy-server=')),
      ).toBe(false);
    });

    it('returns same instance on second call (singleton)', async () => {
      const first = await ensureBrowser({ autoLaunch: true });
      const second = await ensureBrowser({ autoLaunch: true });
      expect(first).toBe(second);
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it('re-connects when browser is disconnected', async () => {
      await ensureBrowser({ autoLaunch: true });

      // Simulate disconnect
      mockConnectedBrowser.connected = false;

      const newConnectedBrowser = {
        connected: true,
        on: vi.fn(),
        process: () => ({ pid: 67890 }),
        wsEndpoint: () => 'ws://127.0.0.1:9222/devtools/browser/new',
        pages: vi.fn().mockResolvedValue([mockPage]),
        targets: vi.fn().mockReturnValue([mockTarget]),
        target: () => ({ createCDPSession: vi.fn().mockResolvedValue(mockCdpSession) }),
        disconnect: vi.fn(),
        close: vi.fn(),
      };
      mockConnect.mockResolvedValueOnce(newConnectedBrowser);

      const browser = await ensureBrowser({ autoLaunch: true });
      expect(browser).toBe(newConnectedBrowser);
    });

    it('registers disconnected event listener', async () => {
      await ensureBrowser({ autoLaunch: true });
      expect(mockConnectedBrowser.on).toHaveBeenCalledWith(
        'disconnected',
        expect.any(Function),
      );
    });

    it('registers targetcreated listener for focus emulation on new tabs', async () => {
      await ensureBrowser({ autoLaunch: true });
      const onCalls = mockConnectedBrowser.on.mock.calls.map(
        (c: [string, Function]) => c[0],
      );
      expect(onCalls).toContain('targetcreated');
    });

    it('throws BrowserNotRunning when autoLaunch=false and no chrome.json', async () => {
      await expect(ensureBrowser()).rejects.toThrow('Chrome is not running');
    });
  });

  describe('isBrowserConnected', () => {
    it('returns false before any launch', () => {
      expect(isBrowserConnected()).toBe(false);
    });

    it('returns true after successful launch', async () => {
      await ensureBrowser({ autoLaunch: true });
      expect(isBrowserConnected()).toBe(true);
    });

    it('returns false after closeBrowser()', async () => {
      await ensureBrowser({ autoLaunch: true });
      await closeBrowser();
      expect(isBrowserConnected()).toBe(false);
    });
  });

  describe('closeBrowser', () => {
    it('calls browser.close() and cleans up', async () => {
      await ensureBrowser({ autoLaunch: true });
      await closeBrowser();
      expect(mockConnectedBrowser.close).toHaveBeenCalled();
      expect(isBrowserConnected()).toBe(false);
    });
  });

  describe('proxy support', () => {
    it('includes --proxy-server when proxy is configured', async () => {
      testConfig = {
        ...testConfig,
        proxy: { server: 'http://127.0.0.1:7890' },
        proxySource: 'SITE_USE_PROXY',
      };
      await ensureBrowser({ autoLaunch: true });
      const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--proxy-server=http://127.0.0.1:7890');
    });

    it('includes --proxy-server for SOCKS5 proxy', async () => {
      testConfig = {
        ...testConfig,
        proxy: { server: 'socks5://127.0.0.1:1080' },
        proxySource: 'HTTPS_PROXY',
      };
      await ensureBrowser({ autoLaunch: true });
      const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--proxy-server=socks5://127.0.0.1:1080');
    });
  });

  describe('platform-specific args', () => {
    it('does not include --no-sandbox on non-linux platforms', async () => {
      await ensureBrowser({ autoLaunch: true });
      const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
      if (process.platform !== 'linux') {
        expect(spawnArgs).not.toContain('--no-sandbox');
      }
    });
  });

  describe('fixPreferences', () => {
    it('forces intl.accept_languages to en-US,en', async () => {
      // Override readFileSync to return prefs for Preferences, normal behavior for chrome.json
      vi.mocked(readFileSync).mockImplementation((filePath: any, _enc?: any) => {
        const fp = String(filePath);
        if (fp.endsWith('chrome.json') && chromeJsonStore[fp]) {
          return chromeJsonStore[fp];
        }
        if (fp.endsWith('DevToolsActivePort')) {
          return '9222\n/devtools/browser/mock\n';
        }
        if (fp.includes('Preferences')) {
          return JSON.stringify({
            intl: { accept_languages: 'zh-CN,zh' },
          });
        }
        throw new Error('ENOENT');
      });

      await ensureBrowser({ autoLaunch: true });

      // Find the Preferences write (not chrome.json write)
      const prefsWrites = vi.mocked(writeFileSync).mock.calls.filter(
        (c) => String(c[0]).includes('Preferences'),
      );
      expect(prefsWrites.length).toBe(1);
      const written = JSON.parse(prefsWrites[0][1] as string);
      expect(written.intl.accept_languages).toBe('en-US,en');
    });

    it('does not write Preferences when all preferences are correct', async () => {
      vi.mocked(readFileSync).mockImplementation((filePath: any, _enc?: any) => {
        const fp = String(filePath);
        if (fp.endsWith('chrome.json') && chromeJsonStore[fp]) {
          return chromeJsonStore[fp];
        }
        if (fp.endsWith('DevToolsActivePort')) {
          return '9222\n/devtools/browser/mock\n';
        }
        // Return correct prefs so fixPreferences should NOT write
        return JSON.stringify({
          intl: { accept_languages: 'en-US,en' },
          session: { restore_on_startup: 1 },
          webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
        });
      });

      // Clear writeFileSync call history before the test action
      vi.mocked(writeFileSync).mockClear();

      await ensureBrowser({ autoLaunch: true });

      // Filter only Preferences writes (chrome.json writes are expected)
      const prefsWrites = vi.mocked(writeFileSync).mock.calls.filter(
        (c) => !String(c[0]).endsWith('chrome.json'),
      );
      expect(prefsWrites.length).toBe(0);
    });

    it('silently handles missing Preferences file', async () => {
      // Default mock already throws ENOENT for non-chrome.json files — just launch
      const browser = await ensureBrowser({ autoLaunch: true });
      expect(browser).toBe(mockConnectedBrowser);
    });
  });

  describe('error handling', () => {
    it('throws BrowserNotRunning when Chrome executable not found', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValue(false);
      await expect(ensureBrowser({ autoLaunch: true })).rejects.toThrow('Chrome executable not found');
    });

    it('thrown error is instance of BrowserNotRunning', async () => {
      const { existsSync } = await import('node:fs');
      vi.mocked(existsSync).mockReturnValue(false);
      try {
        await ensureBrowser({ autoLaunch: true });
        expect.unreachable('should have thrown');
      } catch (err) {
        const { BrowserNotRunning } = await import('../../src/errors.js');
        expect(err).toBeInstanceOf(BrowserNotRunning);
      }
    });

    it('can recover after a failed launch', async () => {
      const { existsSync } = await import('node:fs');
      // First call: Chrome not found
      vi.mocked(existsSync).mockReturnValue(false);
      await expect(ensureBrowser({ autoLaunch: true })).rejects.toThrow();

      // Second call: Chrome found (restore defaults)
      vi.mocked(existsSync).mockImplementation(defaultExistsSync as any);
      const browser = await ensureBrowser({ autoLaunch: true });
      expect(browser).toBe(mockConnectedBrowser);
    });
  });
});
