import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { injectCoordFix } from '../primitives/click-enhanced.js';
import { BrowserDisconnected } from '../errors.js';
import { buildWelcomeHTML } from './welcome.js';

let browserInstance: Browser | null = null;

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

function fixPreferences(profileDir: string): void {
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

    if (dirty) {
      writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8');
    }
  } catch {
    // Preferences file may not exist for new profiles
  }
}

export async function ensureBrowser(extraArgs?: string[]): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const config = getConfig();

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

  const proxyLog = config.proxySource
    ? `${config.proxy!.server} (from ${config.proxySource}${config.proxySource !== 'SITE_USE_PROXY' ? ' fallback' : ''})`
    : 'none';
  console.error(`[site-use] Proxy: ${proxyLog}`);

  fixPreferences(config.chromeProfileDir);

  try {
    browserInstance = await puppeteer.launch({
      channel: 'chrome',
      headless: false,
      defaultViewport: null,
      args,
      ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    });
  } catch (err) {
    throw new BrowserDisconnected(
      `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  // First launch: show the welcome page via data URL
  // Session restore: close the extra about:blank tab Puppeteer opens
  const pages = await browserInstance.pages();
  const blank = pages.find((p) => p.url() === 'about:blank');

  // Keep pages focused even when browser window is in background.
  // Also locks document.visibilityState to "visible".
  // Must be set per-page (Emulation is a page-level CDP domain).
  await emulateFocus(pages);
  await applyCoordFix(pages);
  browserInstance.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const page = await target.page();
      if (page) await emulateFocus([page]);
      if (page) await applyCoordFix([page]);
    }
  });
  if (blank) {
    if (pages.length === 1) {
      const html = buildWelcomeHTML();
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await blank.goto(dataUrl, { waitUntil: 'domcontentloaded' });
    } else {
      await blank.close();
    }
  }

  return browserInstance;
}

export function closeBrowser(): void {
  browserInstance = null;
}

export function isBrowserConnected(): boolean {
  return browserInstance !== null && browserInstance.connected;
}
