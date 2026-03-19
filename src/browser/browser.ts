import puppeteer, { type Browser } from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { BrowserDisconnected } from '../errors.js';

let browserInstance: Browser | null = null;

function fixPreferences(profileDir: string): void {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const raw = readFileSync(prefsPath, 'utf-8');
    const prefs = JSON.parse(raw);
    let dirty = false;

    // Prevent "Chrome didn't shut down correctly" restore prompt
    if (prefs.profile?.exit_type !== 'Normal') {
      prefs.profile.exit_type = 'Normal';
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
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    '--lang=en-US',
    '--accept-lang=en-US,en',
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
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (err) {
    throw new BrowserDisconnected(
      `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
}

export function closeBrowser(): void {
  browserInstance = null;
}

export function isBrowserConnected(): boolean {
  return browserInstance !== null && browserInstance.connected;
}
