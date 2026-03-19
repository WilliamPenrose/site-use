import puppeteer, { type Browser } from 'puppeteer-core';
import { getConfig } from '../config.js';
import { BrowserDisconnected } from '../errors.js';

let browserInstance: Browser | null = null;

export async function ensureBrowser(): Promise<Browser> {
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
  ];

  if (config.proxy) {
    args.push(`--proxy-server=${config.proxy.server}`);
  }

  const proxyLog = config.proxySource
    ? `${config.proxy!.server} (from ${config.proxySource}${config.proxySource !== 'SITE_USE_PROXY' ? ' fallback' : ''})`
    : 'none';
  console.error(`[site-use] Proxy: ${proxyLog}`);

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

  // Remove navigator.webdriver via CDP on every new page
  browserInstance.on('targetcreated', async (target) => {
    const page = await target.page();
    if (page) {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });
    }
  });

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
