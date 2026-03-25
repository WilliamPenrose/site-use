import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getConfig, type WebRTCPolicy } from '../config.js';
import { injectCoordFix } from '../primitives/click-enhanced.js';
import { BrowserDisconnected, BrowserNotRunning } from '../errors.js';
import { isPidAlive } from '../lock.js';
import { buildWelcomeHTML } from './welcome.js';

let browserInstance: Browser | null = null;

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Lightweight CDP health check. Sends Browser.getVersion (fast, no page needed).
 * If Chrome is unresponsive (e.g. long-running, memory pressure), this times out
 * and throws with a clear restart hint.
 */
async function checkBrowserHealth(browser: Browser): Promise<void> {
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
    throw new BrowserDisconnected(
      'Chrome is unresponsive (health check timed out). Restart it with: npx site-use browser close && npx site-use browser launch',
      { step: 'healthCheck' },
    );
  }
}

const PROTOCOL_TIMEOUT_MS = 30_000;

/** Connect to Chrome with consistent defaults. */
function connectBrowser(wsEndpoint: string): Promise<Browser> {
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });
}

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
// recoverOrphanChrome — rebuild chrome.json from DevToolsActivePort
// ---------------------------------------------------------------------------
// When Chrome is running but chrome.json is missing (orphaned state),
// Chrome's DevToolsActivePort file contains the debug port and ws path.
// We parse it, locate the Chrome PID via the debug endpoint, and rebuild
// chrome.json so launch/close can work normally.

export async function recoverOrphanChrome(
  chromeProfileDir: string,
  chromeJsonPath: string,
): Promise<ChromeInfo | null> {
  const dtapPath = path.join(chromeProfileDir, 'DevToolsActivePort');
  if (!existsSync(dtapPath)) return null;

  let port: number;
  let wsPath: string;
  try {
    const lines = readFileSync(dtapPath, 'utf-8').trim().split('\n');
    if (lines.length < 2) return null;
    port = parseInt(lines[0], 10);
    wsPath = lines[1];
    if (!port || !wsPath) return null;
  } catch {
    return null;
  }

  // Fetch /json/version to get the full wsEndpoint and confirm Chrome is alive
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    const wsEndpoint = data.webSocketDebuggerUrl;
    if (!wsEndpoint) return null;

    // Connect briefly to get the PID
    const browser = await connectBrowser(wsEndpoint);
    const pid = browser.process()?.pid;
    // Puppeteer doesn't expose PID on connect — use /json/version port to find it
    browser.disconnect();

    // On connect, browser.process() returns null. Find PID from the lockfile
    // or enumerate Chrome processes. Simplest: trust the port is alive and
    // scan processes listening on it. But cross-platform process scanning is
    // fragile. Instead, use the lockfile that Chrome writes.
    const lockfilePath = path.join(chromeProfileDir, 'lockfile');
    let chromePid: number | undefined;
    if (pid) {
      chromePid = pid;
    } else if (existsSync(lockfilePath)) {
      // On Windows, Chrome lockfile is empty but its existence proves Chrome owns the profile.
      // Find Chrome PID by checking who listens on the debug port.
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

async function findPidOnPort(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const { execSync } = await import('node:child_process');
    try {
      // netstat output: "  TCP    127.0.0.1:PORT    0.0.0.0:0    LISTENING    PID"
      const output = execSync(`netstat -ano -p TCP`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) return pid;
        }
      }
    } catch {}
  } else {
    // Unix: lsof
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 5000 });
      const pid = parseInt(output.trim().split('\n')[0], 10);
      if (pid > 0) return pid;
    } catch {}
  }
  return undefined;
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
// findChromeExecutable — resolve Chrome binary path
// ---------------------------------------------------------------------------

function findChromeExecutable(): string {
  if (process.platform === 'win32') {
    const envVars = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'] as const;
    for (const envVar of envVars) {
      const base = process.env[envVar];
      if (!base) continue;
      const p = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(p)) return p;
  } else {
    // Linux: check common paths
    for (const name of ['google-chrome-stable', 'google-chrome', 'chrome', 'chromium-browser', 'chromium']) {
      const p = `/usr/bin/${name}`;
      if (existsSync(p)) return p;
    }
  }
  throw new BrowserDisconnected(
    'Chrome executable not found. Install Google Chrome or set a custom path.',
  );
}

// ---------------------------------------------------------------------------
// waitForDevToolsPort — poll DevToolsActivePort until Chrome is ready
// ---------------------------------------------------------------------------

async function waitForDevToolsPort(
  chromeProfileDir: string,
  pid: number,
  timeoutMs = 30_000,
): Promise<string> {
  const dtapPath = path.join(chromeProfileDir, 'DevToolsActivePort');
  // Chrome writes this file once the debug server is ready.
  // Remove stale file before launch so we don't read old data.
  try { unlinkSync(dtapPath); } catch {}

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      throw new BrowserDisconnected('Chrome exited before debug port was available');
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
      // File not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new BrowserDisconnected('Timed out waiting for Chrome debug port');
}

// ---------------------------------------------------------------------------
// launchAndDetach — launch Chrome as a detached process, write chrome.json
// ---------------------------------------------------------------------------
// On Windows, Node.js places child processes in a job object — when Node
// exits, all job members are killed.  Using spawn() with detached:true
// creates Chrome in its own process group, so it survives parent exit.

export async function launchAndDetach(extraArgs?: string[]): Promise<ChromeInfo> {
  const config = getConfig();
  const args = buildLaunchArgs(config, extraArgs);

  const proxyLog = config.proxySource
    ? `${config.proxy!.server} (from ${config.proxySource}${config.proxySource !== 'SITE_USE_PROXY' ? ' fallback' : ''})`
    : 'none';
  console.error(`[site-use] Proxy: ${proxyLog}`);

  fixPreferences(config.chromeProfileDir, config.webrtcPolicy);

  const chromePath = findChromeExecutable();

  // Spawn Chrome detached so it outlives this Node.js process
  const chromeProc = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  chromeProc.unref();

  const pid = chromeProc.pid;
  if (!pid) {
    throw new BrowserDisconnected('Chrome launched but PID not available');
  }

  // Wait for Chrome to write its debug port
  const wsEndpoint = await waitForDevToolsPort(config.chromeProfileDir, pid);

  const info: ChromeInfo = { pid, wsEndpoint };
  writeChromeJson(config.chromeJsonPath, info);

  // Connect briefly to handle welcome page / blank tab
  let browser: Browser;
  try {
    browser = await connectBrowser(wsEndpoint);
  } catch (err) {
    // Chrome is running but connect failed — still return info
    return info;
  }

  try {
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
  } finally {
    browser.disconnect();
  }

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
    browserInstance = await connectBrowser(info.wsEndpoint);
  } catch {
    // Connection failed — chrome.json is stale
    try { unlinkSync(config.chromeJsonPath); } catch {}

    if (!autoLaunch) {
      throw new BrowserNotRunning('Chrome is not running (connection failed). Launch it first with: npx site-use browser launch');
    }

    // Relaunch and connect
    info = await launchAndDetach(opts?.extraArgs);
    browserInstance = await connectBrowser(info.wsEndpoint);
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  // Health check — lightweight CDP ping to detect unresponsive Chrome
  await checkBrowserHealth(browserInstance);

  // Apply per-connection setup on EVERY connect
  await applyConnectionSetup(browserInstance);
  await applyProxyAuth(browserInstance);

  return browserInstance;
}

// ---------------------------------------------------------------------------
// closeBrowser — kill Chrome and delete chrome.json
// ---------------------------------------------------------------------------

export interface CloseResult {
  found: boolean;
  pid?: number;
  recovered?: boolean;
}

export async function closeBrowser(): Promise<CloseResult> {
  const config = getConfig();
  let info = readChromeJson(config.chromeJsonPath);
  let recovered = false;

  // If chrome.json is missing, try to recover orphan Chrome
  if (!info) {
    info = await recoverOrphanChrome(config.chromeProfileDir, config.chromeJsonPath);
    if (info) recovered = true;
  }

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

  return { found: !!info, pid: info?.pid, recovered };
}

// ---------------------------------------------------------------------------
// isBrowserConnected — check if we have a live connection
// ---------------------------------------------------------------------------

export function isBrowserConnected(): boolean {
  return browserInstance !== null && browserInstance.connected;
}
