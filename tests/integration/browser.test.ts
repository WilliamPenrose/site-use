import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, closeBrowser, isBrowserConnected } from '../../src/browser/browser.js';

// Use a temp directory as SITE_USE_DATA_DIR so we don't pollute the real profile
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-test-'));
  process.env.SITE_USE_DATA_DIR = tmpDir;
  // Clear proxy env vars to avoid interference
  delete process.env.SITE_USE_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
});

afterEach(async () => {
  // closeBrowser() now kills Chrome and cleans up chrome.json
  await closeBrowser();

  // Clean up temp profile dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('browser integration', () => {
  it('launches a real Chrome instance and connects', async () => {
    const browser = await ensureBrowser({ autoLaunch: true });

    expect(browser.connected).toBe(true);
    expect(isBrowserConnected()).toBe(true);
  }, 15_000);

  it('creates the chrome-profile directory on launch', async () => {
    await ensureBrowser({ autoLaunch: true });

    const profileDir = path.join(tmpDir, 'chrome-profile');
    expect(fs.existsSync(profileDir)).toBe(true);
  }, 15_000);

  it('returns the same instance on second call (singleton)', async () => {
    const first = await ensureBrowser({ autoLaunch: true });
    const second = await ensureBrowser({ autoLaunch: true });

    expect(first).toBe(second);
  }, 15_000);

  it('recovers after Chrome process is killed', async () => {
    const browser = await ensureBrowser({ autoLaunch: true });
    const firstPid = browser.process()?.pid;
    expect(firstPid).toBeDefined();

    // Kill Chrome process to simulate crash
    await browser.close();

    // Singleton should detect disconnection, next call should re-launch
    expect(isBrowserConnected()).toBe(false);

    const newBrowser = await ensureBrowser({ autoLaunch: true });
    expect(newBrowser.connected).toBe(true);
    expect(newBrowser).not.toBe(browser);
  }, 20_000);

  it('closeBrowser() kills Chrome and cleans up', async () => {
    const browser = await ensureBrowser({ autoLaunch: true });
    const pid = browser.process()?.pid;
    expect(pid).toBeDefined();

    await closeBrowser();

    // Singleton cleared
    expect(isBrowserConnected()).toBe(false);

    // Chrome process should be dead after closeBrowser
    let processAlive = false;
    try {
      process.kill(pid!, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
    expect(processAlive).toBe(false);
  }, 15_000);
});
