import type { Browser, Page } from 'puppeteer-core';
import {
  createRuntime,
  type ChromeInfo,
  type CloseResult,
} from '@site-use/runtime';
import { injectCoordFix } from '@site-use/runtime/internal/primitives';
import { getConfig } from '../config.js';
import { buildWelcomeHTML } from './welcome.js';

let runtime: ReturnType<typeof createRuntime> | null = null;

function getRuntime(): ReturnType<typeof createRuntime> {
  if (runtime) return runtime;
  const cfg = getConfig();
  runtime = createRuntime({
    config: {
      dataDir: cfg.dataDir,
      chromeProfileDir: cfg.chromeProfileDir,
      chromeJsonPath: cfg.chromeJsonPath,
      proxy: cfg.proxy,
      proxySource: cfg.proxySource,
      webrtcPolicy: cfg.webrtcPolicy,
    },
    hooks: {
      injectCoordFix,
      buildWelcomeHTML,
    },
  });
  return runtime;
}

export type { ChromeInfo, CloseResult };

export function readChromeJson(chromeJsonPath: string): ChromeInfo | null {
  return getRuntime().readChromeJson(chromeJsonPath);
}

export function writeChromeJson(chromeJsonPath: string, info: ChromeInfo): void {
  getRuntime().writeChromeJson(chromeJsonPath, info);
}

export async function recoverOrphanChrome(
  chromeProfileDir: string,
  chromeJsonPath: string,
): Promise<ChromeInfo | null> {
  return await getRuntime().recoverOrphanChrome(chromeProfileDir, chromeJsonPath);
}

export async function launchAndDetach(extraArgs?: string[]): Promise<ChromeInfo> {
  return await getRuntime().launchBrowser(extraArgs);
}

export async function ensureBrowser(opts?: { autoLaunch?: boolean; extraArgs?: string[] }): Promise<Browser> {
  return await getRuntime().ensureBrowser({
    autoLaunch: opts?.autoLaunch ?? false,
    extraArgs: opts?.extraArgs,
  });
}

export async function closeBrowser(): Promise<CloseResult> {
  return await getRuntime().closeBrowser();
}

export function isBrowserConnected(): boolean {
  return getRuntime().isBrowserConnected();
}

export async function safePages(browser: Browser): Promise<Page[]> {
  return await getRuntime().safePages(browser);
}

export async function unfreezePages(pages: Page[]): Promise<void> {
  await getRuntime().unfreezePages(pages);
}

/** @internal — for unit tests only. */
export function __resetRuntimeForTesting(): void {
  runtime = null;
}
