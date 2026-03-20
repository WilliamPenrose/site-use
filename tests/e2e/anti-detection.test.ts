import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, closeBrowser } from '../../src/browser/browser.js';
import type { Browser, Page } from 'puppeteer-core';

let browser: Browser;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-e2e-'));
  process.env.SITE_USE_DATA_DIR = tmpDir;
  delete process.env.SITE_USE_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  browser = await ensureBrowser();
}, 30_000);

afterAll(async () => {
  closeBrowser();
  await browser?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Poll a condition with timeout.
 * Returns the first truthy value from `fn`, or null if timeout is reached.
 */
async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Click an element using mouse movement to simulate real user interaction.
 * Standard page.click() dispatches synthetic DOM events that some detectors
 * can distinguish from real input. This moves the cursor to the element's
 * center then clicks, which is closer to real user behavior.
 */
async function realClick(page: Page, selector: string): Promise<void> {
  const el = await page.waitForSelector(selector, { timeout: 10_000 });
  if (!el) throw new Error(`Element not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`Element has no bounding box: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

describe('anti-detection', () => {
  it('passes Brotector webdriver detector', async () => {
    const page = await browser.newPage();
    try {
      // crash=false prevents Brotector from crashing the tab when bot is detected
      await page.goto('https://ttlns.github.io/brotector/?crash=false', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Brotector starts with #table-keys bgcolor="darkgreen".
      // When a bot is detected, log() changes it to red/orange/yellow.
      // If the browser passes (not a bot), no detections fire and color stays green.
      // Wait a few seconds for detections to run, then dump diagnostics.
      await new Promise((r) => setTimeout(r, 5_000));

      const diag = await page.evaluate(() => {
        const tableKeys = document.querySelector('#table-keys');
        const avgScore = document.querySelector('#avg-score');
        const rows = document.querySelectorAll('#detections tr');
        const detections: string[] = [];
        rows.forEach((row, i) => {
          if (i === 0) return; // skip header
          detections.push(row.textContent?.trim() ?? '');
        });
        return {
          color: tableKeys?.getAttribute('bgcolor'),
          avgScore: avgScore?.textContent,
          rowCount: rows.length,
          detections,
          url: window.location.href,
        };
      });
      console.log('[Brotector diagnostics]', JSON.stringify(diag, null, 2));

      expect(diag.color).toBe('darkgreen');
    } finally {
      await page.close();
    }
  }, 60_000);

  // TODO: re-enable after verifying network access
  // it('passes DrissionPage Detector', async () => { ... });
  // it('passes Cloudflare WAF challenge', async () => { ... });
  // it('passes Cloudflare Turnstile', async () => { ... });
  // it('passes Fingerprint JS Bot Detector', async () => { ... });
  // it('passes Datadome Bot Detector', async () => { ... });
});
