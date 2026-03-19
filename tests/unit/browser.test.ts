import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

// Mock puppeteer-core before importing browser module
const mockPage = { url: () => 'about:blank', close: vi.fn(), goto: vi.fn() };
const mockBrowser = {
  connected: true,
  on: vi.fn(),
  process: () => ({ pid: 12345 }),
  pages: vi.fn().mockResolvedValue([mockPage]),
};

const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock('puppeteer-core', () => ({
  default: { launch: mockLaunch },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
    writeFileSync: vi.fn(),
  };
});

// Mutable config for per-test overrides
let testConfig = {
  dataDir: '/tmp/test-site-use',
  chromeProfileDir: '/tmp/test-site-use/chrome-profile',
  proxy: undefined as
    | { server: string; username?: string; password?: string }
    | undefined,
  proxySource: undefined as string | undefined,
};

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => testConfig),
}));

vi.mock('../../src/browser/welcome.js', () => ({
  buildWelcomeHTML: () => '<html>welcome</html>',
}));

// Import after mocks
const { ensureBrowser, closeBrowser, isBrowserConnected } = await import(
  '../../src/browser/browser.js'
);

describe('browser', () => {
  beforeEach(() => {
    closeBrowser();
    mockLaunch.mockClear();
    mockLaunch.mockResolvedValue(mockBrowser);
    mockBrowser.on.mockClear();
    mockBrowser.connected = true;
    testConfig = {
      dataDir: '/tmp/test-site-use',
      chromeProfileDir: '/tmp/test-site-use/chrome-profile',
      proxy: undefined,
      proxySource: undefined,
    };
  });

  describe('ensureBrowser', () => {
    it('launches Chrome and returns a Browser instance', async () => {
      const browser = await ensureBrowser();
      expect(browser).toBe(mockBrowser);
      expect(mockLaunch).toHaveBeenCalledOnce();
    });

    it('passes correct Chrome launch args', async () => {
      await ensureBrowser();
      const launchArgs = mockLaunch.mock.calls[0][0];
      expect(launchArgs.channel).toBe('chrome');
      expect(launchArgs.headless).toBe(false);
      expect(launchArgs.ignoreDefaultArgs).toContain('--enable-automation');
      const args: string[] = launchArgs.args;
      expect(
        args.some((a: string) => a.startsWith('--user-data-dir=')),
      ).toBe(true);
      expect(args).toContain('--remote-debugging-port=0');
      expect(args).toContain('--no-first-run');
      expect(args).toContain('--no-default-browser-check');
      expect(args).toContain('--disable-blink-features=AutomationControlled');
      expect(args).toContain('--window-size=1920,1080');
      expect(args).toContain('--lang=en-US');
      expect(args).toContain('--accept-lang=en-US,en');
      expect(args).toContain('--restore-last-session');
    });

    it('does not include --proxy-server when no proxy configured', async () => {
      await ensureBrowser();
      const args: string[] = mockLaunch.mock.calls[0][0].args;
      expect(
        args.some((a: string) => a.startsWith('--proxy-server=')),
      ).toBe(false);
    });

    it('returns same instance on second call (singleton)', async () => {
      const first = await ensureBrowser();
      const second = await ensureBrowser();
      expect(first).toBe(second);
      expect(mockLaunch).toHaveBeenCalledOnce();
    });

    it('re-launches when browser is disconnected', async () => {
      await ensureBrowser();

      // Simulate disconnect
      mockBrowser.connected = false;

      const newMockBrowser = {
        connected: true,
        on: vi.fn(),
        process: () => ({ pid: 67890 }),
        pages: vi.fn().mockResolvedValue([mockPage]),
      };
      mockLaunch.mockResolvedValueOnce(newMockBrowser);

      const browser = await ensureBrowser();
      expect(browser).toBe(newMockBrowser);
      expect(mockLaunch).toHaveBeenCalledTimes(2);
    });

    it('registers disconnected event listener', async () => {
      await ensureBrowser();
      expect(mockBrowser.on).toHaveBeenCalledWith(
        'disconnected',
        expect.any(Function),
      );
    });

    it('does not register targetcreated listener for webdriver masking', async () => {
      await ensureBrowser();
      const onCalls = mockBrowser.on.mock.calls.map(
        (c: [string, Function]) => c[0],
      );
      expect(onCalls).not.toContain('targetcreated');
    });
  });

  describe('isBrowserConnected', () => {
    it('returns false before any launch', () => {
      expect(isBrowserConnected()).toBe(false);
    });

    it('returns true after successful launch', async () => {
      await ensureBrowser();
      expect(isBrowserConnected()).toBe(true);
    });

    it('returns false after closeBrowser()', async () => {
      await ensureBrowser();
      closeBrowser();
      expect(isBrowserConnected()).toBe(false);
    });
  });

  describe('closeBrowser', () => {
    it('clears the singleton reference without closing Chrome', async () => {
      await ensureBrowser();
      closeBrowser();
      // closeBrowser only nulls the reference — no browser.close() call
      // (mockBrowser has no close method, so if called it would throw)
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
      await ensureBrowser();
      const args: string[] = mockLaunch.mock.calls[0][0].args;
      expect(args).toContain('--proxy-server=http://127.0.0.1:7890');
    });

    it('includes --proxy-server for SOCKS5 proxy', async () => {
      testConfig = {
        ...testConfig,
        proxy: { server: 'socks5://127.0.0.1:1080' },
        proxySource: 'HTTPS_PROXY',
      };
      await ensureBrowser();
      const args: string[] = mockLaunch.mock.calls[0][0].args;
      expect(args).toContain('--proxy-server=socks5://127.0.0.1:1080');
    });
  });

  describe('platform-specific args', () => {
    it('does not include --no-sandbox on non-linux platforms', async () => {
      await ensureBrowser();
      const args: string[] = mockLaunch.mock.calls[0][0].args;
      if (process.platform !== 'linux') {
        expect(args).not.toContain('--no-sandbox');
      }
    });
  });

  describe('fixPreferences', () => {
    beforeEach(() => {
      vi.mocked(readFileSync).mockReset();
      vi.mocked(writeFileSync).mockReset();
    });

    it('rewrites exit_type to Normal when it is Crashed', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          profile: { exit_type: 'Crashed' },
          intl: { accept_languages: 'en-US,en' },
        }),
      );

      await ensureBrowser();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(
        vi.mocked(writeFileSync).mock.calls[0][1] as string,
      );
      expect(written.profile.exit_type).toBe('Normal');
    });

    it('forces intl.accept_languages to en-US,en', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          profile: { exit_type: 'Normal' },
          intl: { accept_languages: 'zh-CN,zh' },
        }),
      );

      await ensureBrowser();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(
        vi.mocked(writeFileSync).mock.calls[0][1] as string,
      );
      expect(written.intl.accept_languages).toBe('en-US,en');
    });

    it('does not write when all preferences are correct', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          profile: { exit_type: 'Normal' },
          intl: { accept_languages: 'en-US,en' },
          session: { restore_on_startup: 1 },
        }),
      );

      await ensureBrowser();

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('silently handles missing Preferences file', async () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      // Should not throw
      const browser = await ensureBrowser();
      expect(browser).toBe(mockBrowser);
    });
  });

  describe('error handling', () => {
    it('throws BrowserDisconnected when Chrome fails to launch', async () => {
      mockLaunch.mockRejectedValueOnce(new Error('Chrome not found'));
      await expect(ensureBrowser()).rejects.toThrow('Failed to launch Chrome');
    });

    it('thrown error is instance of BrowserDisconnected', async () => {
      mockLaunch.mockRejectedValueOnce(new Error('Chrome not found'));
      try {
        await ensureBrowser();
        expect.unreachable('should have thrown');
      } catch (err) {
        const { BrowserDisconnected } = await import('../../src/errors.js');
        expect(err).toBeInstanceOf(BrowserDisconnected);
      }
    });

    it('can recover after a failed launch', async () => {
      // First call fails
      mockLaunch.mockRejectedValueOnce(new Error('Chrome not found'));
      await expect(ensureBrowser()).rejects.toThrow();

      // Second call succeeds (mockLaunch falls back to default mock)
      const browser = await ensureBrowser();
      expect(browser).toBe(mockBrowser);
    });
  });
});
