import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, closeBrowser, isBrowserConnected } from '../../src/browser/browser.js';
import type { Browser } from 'puppeteer-core';

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
  // Get browser reference before clearing singleton
  // We need to actually close Chrome in tests (unlike production behavior)
  if (isBrowserConnected()) {
    const browser = await ensureBrowser();
    closeBrowser();
    await browser.close();
  } else {
    closeBrowser();
  }

  // Clean up temp profile dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('browser integration', () => {
  it('launches a real Chrome instance and connects', async () => {
    const browser = await ensureBrowser();

    expect(browser.connected).toBe(true);
    expect(isBrowserConnected()).toBe(true);
  }, 15_000);

  it('creates the chrome-profile directory on launch', async () => {
    await ensureBrowser();

    const profileDir = path.join(tmpDir, 'chrome-profile');
    expect(fs.existsSync(profileDir)).toBe(true);
  }, 15_000);

  it('returns the same instance on second call (singleton)', async () => {
    const first = await ensureBrowser();
    const second = await ensureBrowser();

    expect(first).toBe(second);
  }, 15_000);

  it('recovers after Chrome process is killed', async () => {
    const browser = await ensureBrowser();
    const firstPid = browser.process()?.pid;
    expect(firstPid).toBeDefined();

    // Kill Chrome process to simulate crash
    await browser.close();

    // Singleton should detect disconnection, next call should re-launch
    expect(isBrowserConnected()).toBe(false);

    const newBrowser = await ensureBrowser();
    expect(newBrowser.connected).toBe(true);
    expect(newBrowser).not.toBe(browser);
  }, 20_000);

  it('closeBrowser() detaches without killing Chrome process', async () => {
    const browser = await ensureBrowser();
    const pid = browser.process()?.pid;
    expect(pid).toBeDefined();

    closeBrowser();

    // Singleton cleared
    expect(isBrowserConnected()).toBe(false);

    // Chrome process should still be alive
    // On Windows, process.kill(pid, 0) throws if process doesn't exist
    let processAlive = false;
    try {
      process.kill(pid!, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
    expect(processAlive).toBe(true);

    // Clean up: close Chrome directly since closeBrowser() didn't
    await browser.close();
  }, 15_000);
});
