import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isPidAlive } from './internal/pid.js';
import type { ChromeInfo, CloseResult, ResolvedRuntimeConfig } from './types.js';

const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const PROTOCOL_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;

type RuntimeErrorCtor = new (message: string, context?: Record<string, unknown>) => Error;

export interface BrowserLifecycleHooks {
  injectCoordFix?: (page: Page) => Promise<void>;
  buildWelcomeHTML?: () => string;
  BrowserDisconnected?: RuntimeErrorCtor;
  BrowserNotRunning?: RuntimeErrorCtor;
  ensureBrowser?: (opts?: { autoLaunch?: boolean; extraArgs?: string[] }) => Promise<Browser>;
  closeBrowser?: () => Promise<CloseResult>;
  safePages?: (browser: Browser) => Promise<Page[]>;
}

function makeBrowserDisconnected(
  hooks: BrowserLifecycleHooks,
  message: string,
  context: Record<string, unknown> = {},
): Error {
  const Ctor = hooks.BrowserDisconnected ?? Error;
  return new Ctor(message, context);
}

function makeBrowserNotRunning(
  hooks: BrowserLifecycleHooks,
  message: string,
  context: Record<string, unknown> = {},
): Error {
  const Ctor = hooks.BrowserNotRunning ?? Error;
  return new Ctor(message, context);
}

export async function safePages(
  browser: Browser,
  hooks: BrowserLifecycleHooks = {},
): Promise<Page[]> {
  if (hooks.safePages) {
    return await hooks.safePages(browser);
  }

  const pages: Page[] = [];
  for (const target of browser.targets()) {
    try {
      if (target.type() !== 'page') continue;
      if (target.url().startsWith('chrome://')) continue;
      const page = await target.page();
      if (page) pages.push(page);
    } catch {
      // crashed or unreachable target
    }
  }
  return pages;
}

async function checkBrowserHealth(browser: Browser, hooks: BrowserLifecycleHooks): Promise<void> {
  try {
    const target = browser.target();
    const client = await target.createCDPSession();
    try {
      await Promise.race([
        client.send('Browser.getVersion'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS),
        ),
      ]);
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    browser.disconnect();
    browserInstance = null;
    throw makeBrowserDisconnected(
      hooks,
      'Chrome is unresponsive (health check timed out). Restart it with: site-use browser close && site-use browser launch',
      { step: 'healthCheck' },
    );
  }
}

function connectBrowser(wsEndpoint: string): Promise<Browser> {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });
}

export function readChromeJson(chromeJsonPath: string): ChromeInfo | null {
  try {
    const data = JSON.parse(readFileSync(chromeJsonPath, 'utf-8'));
    if (!isPidAlive(data.pid)) {
      try {
        unlinkSync(chromeJsonPath);
      } catch {}
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

async function findPidOnPort(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync('netstat -ano -p TCP', { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) return pid;
        }
      }
    } catch {}
  } else {
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 5000 });
      const pid = parseInt(output.trim().split('\n')[0], 10);
      if (pid > 0) return pid;
    } catch {}
  }
  return undefined;
}

export async function recoverOrphanChrome(
  chromeProfileDir: string,
  chromeJsonPath: string,
): Promise<ChromeInfo | null> {
  const dtapPath = path.join(chromeProfileDir, 'DevToolsActivePort');
  if (!existsSync(dtapPath)) return null;

  let port: number;
  try {
    const lines = readFileSync(dtapPath, 'utf-8').trim().split('\n');
    if (lines.length < 2) return null;
    port = parseInt(lines[0], 10);
    if (!port || !lines[1]) return null;
  } catch {
    return null;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return null;
    const data = (await response.json()) as { webSocketDebuggerUrl?: string };
    const wsEndpoint = data.webSocketDebuggerUrl;
    if (!wsEndpoint) return null;

    const browser = await connectBrowser(wsEndpoint);
    const pidFromBrowser = browser.process()?.pid;
    browser.disconnect();

    const lockfilePath = path.join(chromeProfileDir, 'lockfile');
    let chromePid: number | undefined;
    if (pidFromBrowser) {
      chromePid = pidFromBrowser;
    } else if (existsSync(lockfilePath)) {
      chromePid = await findPidOnPort(port);
    }

    if (!chromePid) return null;

    const info: ChromeInfo = { pid: chromePid, wsEndpoint };
    writeChromeJson(chromeJsonPath, info);
    return info;
  } catch {
    return null;
  }
}

async function emulateFocus(pages: Page[]): Promise<void> {
  for (const page of pages) {
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp.detach();
    } catch (error) {
      console.error(
        '[site-use] WARNING: Emulation.setFocusEmulationEnabled failed — ' +
          'document.hasFocus() may return false when window is in background. ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function applyCoordFix(pages: Page[], hooks: BrowserLifecycleHooks): Promise<void> {
  for (const page of pages) {
    try {
      await hooks.injectCoordFix?.(page);
    } catch (error) {
      console.error(
        '[site-use] WARNING: MouseEvent coordinate fix failed — ' +
          'screenX/screenY may be inconsistent. ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function unfreezePages(pages: Page[]): Promise<void> {
  for (const page of pages) {
    let pageUrl = '<unknown>';
    try {
      pageUrl = page.url();
    } catch {}
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await cdp.detach();
      console.error(`[site-use] unfreezePages: OK — ${pageUrl}`);
    } catch (error) {
      console.error(
        `[site-use] unfreezePages: FAILED — ${pageUrl} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function fixPreferences(profileDir: string, webrtcPolicy: ResolvedRuntimeConfig['webrtcPolicy']): void {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const raw = readFileSync(prefsPath, 'utf-8');
    const prefs = JSON.parse(raw);
    let dirty = false;

    if (!prefs.session) prefs.session = {};
    if (prefs.session.restore_on_startup !== 1) {
      prefs.session.restore_on_startup = 1;
      dirty = true;
    }

    if (!prefs.intl) prefs.intl = {};
    if (prefs.intl.accept_languages !== 'en-US,en') {
      prefs.intl.accept_languages = 'en-US,en';
      dirty = true;
    }

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
    // Preferences may not exist yet.
  }
}

function buildLaunchArgs(config: ResolvedRuntimeConfig, extraArgs?: string[]): string[] {
  const args = [
    `--user-data-dir=${config.chromeProfileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1920,1080',
    `--window-position=${30 + Math.floor(Math.random() * 120)},${20 + Math.floor(Math.random() * 80)}`,
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

async function applyConnectionSetup(browser: Browser, hooks: BrowserLifecycleHooks): Promise<void> {
  const pages = await safePages(browser, hooks);
  await emulateFocus(pages);
  await applyCoordFix(pages, hooks);
  await unfreezePages(pages);

  browser.on('targetcreated', async (target) => {
    if (target.type() !== 'page') return;
    const page = await target.page();
    if (page) await emulateFocus([page]);
    if (page) await applyCoordFix([page], hooks);
  });
}

async function applyProxyAuth(
  browser: Browser,
  config: ResolvedRuntimeConfig,
  hooks: BrowserLifecycleHooks,
): Promise<void> {
  if (config.proxy?.username) {
    const pages = await safePages(browser, hooks);
    const page = pages[0];
    if (page) {
      await page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password ?? '',
      });
    }
  }
}

function findChromeExecutable(hooks: BrowserLifecycleHooks): string {
  const customPath = process.env.CHROME_EXECUTABLE_PATH;
  if (customPath) {
    if (existsSync(customPath)) return customPath;
    throw makeBrowserNotRunning(
      hooks,
      `CHROME_EXECUTABLE_PATH is set to "${customPath}" but the file does not exist.`,
    );
  }

  if (process.platform === 'win32') {
    const envVars = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'] as const;
    for (const envVar of envVars) {
      const base = process.env[envVar];
      if (!base) continue;
      const candidate = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (existsSync(candidate)) return candidate;
    }
  } else if (process.platform === 'darwin') {
    const candidate = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(candidate)) return candidate;
  } else {
    for (const name of ['google-chrome-stable', 'google-chrome', 'chrome', 'chromium-browser', 'chromium']) {
      const candidate = `/usr/bin/${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }

  throw makeBrowserNotRunning(
    hooks,
    'Chrome executable not found. Install Google Chrome, or set CHROME_EXECUTABLE_PATH to your Chrome binary path.',
  );
}

async function waitForDevToolsPort(
  chromeProfileDir: string,
  pid: number,
  hooks: BrowserLifecycleHooks,
  timeoutMs = 30_000,
): Promise<string> {
  const dtapPath = path.join(chromeProfileDir, 'DevToolsActivePort');
  try {
    unlinkSync(dtapPath);
  } catch {}

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      throw makeBrowserDisconnected(hooks, 'Chrome exited before debug port was available');
    }
    try {
      const content = readFileSync(dtapPath, 'utf-8').trim();
      const lines = content.split('\n');
      if (lines.length >= 2) {
        const port = parseInt(lines[0], 10);
        const wsPath = lines[1];
        if (port > 0 && wsPath) {
          return `ws://127.0.0.1:${port}${wsPath}`;
        }
      }
    } catch {
      // wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw makeBrowserDisconnected(hooks, 'Timed out waiting for Chrome debug port');
}

export async function launchAndDetach(
  extraArgs: string[] | undefined,
  config: ResolvedRuntimeConfig,
  hooks: BrowserLifecycleHooks,
): Promise<ChromeInfo> {
  const args = buildLaunchArgs(config, extraArgs);

  const proxyLog = config.proxySource
    ? `${config.proxy!.server} (from ${config.proxySource}${config.proxySource !== 'SITE_USE_PROXY' ? ' fallback' : ''})`
    : 'none';
  console.error(`[site-use] Proxy: ${proxyLog}`);

  fixPreferences(config.chromeProfileDir, config.webrtcPolicy);

  const chromePath = findChromeExecutable(hooks);
  const chromeProc = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  chromeProc.unref();

  const pid = chromeProc.pid;
  if (!pid) {
    throw makeBrowserDisconnected(hooks, 'Chrome launched but PID not available');
  }

  const wsEndpoint = await waitForDevToolsPort(config.chromeProfileDir, pid, hooks);
  const info: ChromeInfo = { pid, wsEndpoint };
  writeChromeJson(config.chromeJsonPath, info);

  let browser: Browser;
  try {
    browser = await connectBrowser(wsEndpoint);
  } catch {
    return info;
  }

  try {
    const pages = await safePages(browser, hooks);
    const blank = pages.find((page) => page.url() === 'about:blank');
    if (blank) {
      if (pages.length === 1 && hooks.buildWelcomeHTML) {
        const html = hooks.buildWelcomeHTML();
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
        await blank.goto(dataUrl, { waitUntil: 'domcontentloaded' });
      } else if (pages.length > 1) {
        await blank.close();
      }
    }
  } finally {
    browser.disconnect();
  }

  return info;
}

async function waitForProcessExit(
  pid: number,
  hooks: BrowserLifecycleHooks,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      // Give Chrome a brief grace window to release the profile cleanly
      // before the next launch attempts to reuse it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function ensureBrowser(
  opts: { autoLaunch?: boolean; extraArgs?: string[] } | undefined,
  config: ResolvedRuntimeConfig,
  hooks: BrowserLifecycleHooks,
): Promise<Browser> {
  if (hooks.ensureBrowser) {
    return await hooks.ensureBrowser(opts);
  }

  if (browserInstance && browserInstance.connected) {
    console.error('[site-use] ensureBrowser: reusing cached connection');
    return browserInstance;
  }
  console.error('[site-use] ensureBrowser: creating new connection');

  const autoLaunch = opts?.autoLaunch ?? false;

  let info = readChromeJson(config.chromeJsonPath);

  if (!info) {
    if (!autoLaunch) {
      throw makeBrowserNotRunning(
        hooks,
        'Chrome is not running. Launch it first with: site-use browser launch',
      );
    }
    info = await launchAndDetach(opts?.extraArgs, config, hooks);
  }

  try {
    browserInstance = await connectBrowser(info.wsEndpoint);
  } catch {
    try {
      unlinkSync(config.chromeJsonPath);
    } catch {}

    if (!autoLaunch) {
      throw makeBrowserNotRunning(
        hooks,
        'Chrome is not running (connection failed). Launch it first with: site-use browser launch',
      );
    }

    info = await launchAndDetach(opts?.extraArgs, config, hooks);
    browserInstance = await connectBrowser(info.wsEndpoint);
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  await checkBrowserHealth(browserInstance, hooks);
  await applyConnectionSetup(browserInstance, hooks);
  await applyProxyAuth(browserInstance, config, hooks);

  return browserInstance;
}

export async function closeBrowser(
  config: ResolvedRuntimeConfig,
  hooks: BrowserLifecycleHooks,
): Promise<CloseResult> {
  if (hooks.closeBrowser) {
    return await hooks.closeBrowser();
  }

  let info = readChromeJson(config.chromeJsonPath);
  let recovered = false;

  if (!info) {
    info = await recoverOrphanChrome(config.chromeProfileDir, config.chromeJsonPath);
    if (info) recovered = true;
  }

  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // browser already gone
    }
    browserInstance = null;
  }

  if (info && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // already dead
    }
    await waitForProcessExit(info.pid, hooks);
  }

  try {
    unlinkSync(config.chromeJsonPath);
  } catch {}

  return { found: !!info, pid: info?.pid, recovered };
}

export function isBrowserConnected(): boolean {
  return browserInstance !== null && browserInstance.connected;
}
