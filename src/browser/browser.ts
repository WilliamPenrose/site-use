import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { getConfig, type WebRTCPolicy } from '../config.js';
import { injectCoordFix } from '../primitives/click-enhanced.js';
import { BrowserDisconnected, BrowserNotRunning } from '../errors.js';
import { isPidAlive } from '../lock.js';
import { buildWelcomeHTML } from './welcome.js';

let browserInstance: Browser | null = null;

// ---------------------------------------------------------------------------
// ChromeInfo — shared type for chrome.json persistence
// ---------------------------------------------------------------------------

export interface ChromeInfo {
  pid: number;
  wsEndpoint: string;
}

export function readChromeJson(chromeJsonPath: string): ChromeInfo | null {
  try {
    const data = JSON.parse(readFileSync(chromeJsonPath, 'utf-8'));
    if (!isPidAlive(data.pid)) {
      try { unlinkSync(chromeJsonPath); } catch {}
      return null;
    }
    return { pid: data.pid, wsEndpoint: data.wsEndpoint };
  } catch {
    return null;
  }
}

export function writeChromeJson(chromeJsonPath: string, info: ChromeInfo): void {
  writeFileSync(chromeJsonPath, JSON.stringify(info));
}

// ---------------------------------------------------------------------------
// Page-level setup helpers
// ---------------------------------------------------------------------------

async function emulateFocus(pages: Page[]): Promise<void> {
  for (const page of pages) {
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp.detach();
    } catch (err) {
      console.error(
        '[site-use] WARNING: Emulation.setFocusEmulationEnabled failed — ' +
          'document.hasFocus() may return false when window is in background. ' +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function applyCoordFix(pages: Page[]): Promise<void> {
  for (const page of pages) {
    try {
      await injectCoordFix(page);
    } catch (err) {
      console.error(
        '[site-use] WARNING: MouseEvent coordinate fix failed — ' +
          `screenX/screenY may be inconsistent. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function fixPreferences(profileDir: string, webrtcPolicy: WebRTCPolicy): void {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const raw = readFileSync(prefsPath, 'utf-8');
    const prefs = JSON.parse(raw);
    let dirty = false;

    // Restore previous tabs on startup (Chrome "Continue where you left off")
    if (!prefs.session) prefs.session = {};
    if (prefs.session.restore_on_startup !== 1) {
      prefs.session.restore_on_startup = 1;
      dirty = true;
    }

    // Force en-US language — profile-saved language overrides --lang flag,
    // and Sites layer ARIA matchers depend on English interface
    if (!prefs.intl) prefs.intl = {};
    if (prefs.intl.accept_languages !== 'en-US,en') {
      prefs.intl.accept_languages = 'en-US,en';
      dirty = true;
    }

    // WebRTC IP handling policy — prevents real IP leak via STUN
    if (webrtcPolicy !== 'off') {
      if (!prefs.webrtc) prefs.webrtc = {};
      if (prefs.webrtc.ip_handling_policy !== webrtcPolicy) {
        prefs.webrtc.ip_handling_policy = webrtcPolicy;
        dirty = true;
      }
    } else if (prefs.webrtc?.ip_handling_policy) {
      delete prefs.webrtc.ip_handling_policy;
      dirty = true;
    }

    if (dirty) {
      writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8');
    }
  } catch {
    // Preferences file may not exist for new profiles
  }
}

// ---------------------------------------------------------------------------
// Shared Chrome launch args builder
// ---------------------------------------------------------------------------

function buildLaunchArgs(config: ReturnType<typeof getConfig>, extraArgs?: string[]): string[] {
  const args = [
    `--user-data-dir=${config.chromeProfileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    '--restore-last-session',
  ];

  if (process.platform === 'linux') {
    args.push('--no-sandbox');
  }

  if (config.proxy) {
    args.push(`--proxy-server=${config.proxy.server}`);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Apply per-connection setup (focus emulation, coord fix, new-tab listener)
// ---------------------------------------------------------------------------

async function applyConnectionSetup(browser: Browser): Promise<void> {
  const pages = await browser.pages();
  await emulateFocus(pages);
  await applyCoordFix(pages);

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const page = await target.page();
      if (page) await emulateFocus([page]);
      if (page) await applyCoordFix([page]);
    }
  });
}

// ---------------------------------------------------------------------------
// Apply proxy auth if configured
// ---------------------------------------------------------------------------

async function applyProxyAuth(browser: Browser): Promise<void> {
  const config = getConfig();
  if (config.proxy?.username) {
    const pages = await browser.pages();
    const page = pages[0];
    if (page) {
      await page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password ?? '',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// launchAndDetach — launch Chrome, write chrome.json, disconnect (Chrome stays alive)
// ---------------------------------------------------------------------------

export async function launchAndDetach(extraArgs?: string[]): Promise<ChromeInfo> {
  const config = getConfig();
  const args = buildLaunchArgs(config, extraArgs);

  const proxyLog = config.proxySource
    ? `${config.proxy!.server} (from ${config.proxySource}${config.proxySource !== 'SITE_USE_PROXY' ? ' fallback' : ''})`
    : 'none';
  console.error(`[site-use] Proxy: ${proxyLog}`);

  fixPreferences(config.chromeProfileDir, config.webrtcPolicy);

  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      channel: 'chrome',
      headless: false,
      defaultViewport: null,
      args,
      ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (err) {
    throw new BrowserDisconnected(
      `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pid = browser.process()?.pid;
  if (!pid) {
    throw new BrowserDisconnected('Chrome launched but PID not available');
  }

  const wsEndpoint = browser.wsEndpoint();
  const info: ChromeInfo = { pid, wsEndpoint };
  writeChromeJson(config.chromeJsonPath, info);

  // Handle welcome page / blank tab
  const pages = await browser.pages();
  const blank = pages.find((p) => p.url() === 'about:blank');
  if (blank) {
    if (pages.length === 1) {
      const html = buildWelcomeHTML();
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await blank.goto(dataUrl, { waitUntil: 'domcontentloaded' });
    } else {
      await blank.close();
    }
  }

  // Do NOT apply emulateFocus/applyCoordFix — they'd be lost on disconnect
  browser.disconnect();

  return info;
}

// ---------------------------------------------------------------------------
// ensureBrowser — connect to existing Chrome or optionally launch one
// ---------------------------------------------------------------------------

export async function ensureBrowser(opts?: { autoLaunch?: boolean; extraArgs?: string[] }): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const config = getConfig();
  const autoLaunch = opts?.autoLaunch ?? false;

  let info = readChromeJson(config.chromeJsonPath);

  // No chrome.json — either launch or throw
  if (!info) {
    if (!autoLaunch) {
      throw new BrowserNotRunning('Chrome is not running. Launch it first with: npx site-use browser launch');
    }
    info = await launchAndDetach(opts?.extraArgs);
  }

  // Try to connect
  try {
    browserInstance = await puppeteer.connect({
      browserWSEndpoint: info.wsEndpoint,
      defaultViewport: null,
    });
  } catch {
    // Connection failed — chrome.json is stale
    try { unlinkSync(config.chromeJsonPath); } catch {}

    if (!autoLaunch) {
      throw new BrowserNotRunning('Chrome is not running (connection failed). Launch it first with: npx site-use browser launch');
    }

    // Relaunch and connect
    info = await launchAndDetach(opts?.extraArgs);
    browserInstance = await puppeteer.connect({
      browserWSEndpoint: info.wsEndpoint,
      defaultViewport: null,
    });
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  // Apply per-connection setup on EVERY connect
  await applyConnectionSetup(browserInstance);
  await applyProxyAuth(browserInstance);

  return browserInstance;
}

// ---------------------------------------------------------------------------
// closeBrowser — kill Chrome and delete chrome.json
// ---------------------------------------------------------------------------

export async function closeBrowser(): Promise<void> {
  const config = getConfig();
  const info = readChromeJson(config.chromeJsonPath);

  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // Browser may already be gone
    }
    browserInstance = null;
  }

  // Fallback: if browser.close() didn't kill the process (connect mode),
  // kill it by PID directly
  if (info && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // Process already gone
    }
  }

  try { unlinkSync(config.chromeJsonPath); } catch {}
}

// ---------------------------------------------------------------------------
// isBrowserConnected — check if we have a live connection
// ---------------------------------------------------------------------------

export function isBrowserConnected(): boolean {
  return browserInstance !== null && browserInstance.connected;
}
