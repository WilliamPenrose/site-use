import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, closeBrowser, isBrowserConnected, readChromeJson } from '../../src/browser/browser.js';
import { getConfig } from '../../src/config.js';

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

  // Wait briefly for Chrome to fully release file handles (Windows EPERM workaround)
  await new Promise((r) => setTimeout(r, 500));

  // Clean up temp profile dir — tolerate EPERM on Windows
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
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
    await ensureBrowser({ autoLaunch: true });
    const config = getConfig();
    const info = readChromeJson(config.chromeJsonPath);
    expect(info).not.toBeNull();
    const firstPid = info!.pid;

    // Kill Chrome by closing the browser directly (simulate crash)
    await closeBrowser();

    // Singleton should detect disconnection, next call should re-launch
    expect(isBrowserConnected()).toBe(false);

    const newBrowser = await ensureBrowser({ autoLaunch: true });
    expect(newBrowser.connected).toBe(true);
  }, 20_000);

  it('closeBrowser() kills Chrome and cleans up', async () => {
    await ensureBrowser({ autoLaunch: true });
    const config = getConfig();
    const info = readChromeJson(config.chromeJsonPath);
    expect(info).not.toBeNull();
    const pid = info!.pid;

    await closeBrowser();

    // Singleton cleared
    expect(isBrowserConnected()).toBe(false);

    // Chrome process should be dead after closeBrowser
    let processAlive = false;
    try {
      process.kill(pid, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
    expect(processAlive).toBe(false);
  }, 15_000);
});
