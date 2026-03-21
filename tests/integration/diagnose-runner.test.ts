import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, closeBrowser } from '../../src/browser/browser.js';
// Import from dist/ because the runner starts a server that resolves static
// files (checks.js) relative to import.meta.url — only correct in dist/.
import { runDiagnose } from '../../dist/diagnose/runner.js';
import type { Browser } from 'puppeteer-core';
import type { DiagnoseResult } from '../../dist/diagnose/runner.js';

let browser: Browser;
let tmpDir: string;
let cachedResults: DiagnoseResult[];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-diag-'));
  process.env.SITE_USE_DATA_DIR = tmpDir;
  delete process.env.SITE_USE_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  browser = await ensureBrowser();
  // Run diagnose once and cache results for all assertions
  cachedResults = await runDiagnose(browser, { keepOpen: false });
}, 60_000);

afterAll(async () => {
  closeBrowser();
  await browser?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('diagnose runner', () => {
  it('returns results array with all checks', () => {
    expect(Array.isArray(cachedResults)).toBe(true);
    expect(cachedResults.length).toBeGreaterThan(10);
    for (const r of cachedResults) {
      expect(r).toHaveProperty('meta');
      expect(r).toHaveProperty('result');
      expect(r.meta).toHaveProperty('id');
      expect(r.meta).toHaveProperty('name');
      expect(r.result).toHaveProperty('pass');
      expect(r.result).toHaveProperty('actual');
    }
    const ids = cachedResults.map((r) => r.meta.id);
    expect(ids).toContain('webdriver');
    expect(ids).toContain('browser-info');
    expect(ids).toContain('stack-signature');
  });

  it('webdriver check passes with our Chrome args', () => {
    const wd = cachedResults.find((r) => r.meta.id === 'webdriver');
    expect(wd?.result.pass).toBe(true);
  });

  it('includes scroll trajectory analysis results', () => {
    const scrollChecks = cachedResults.filter((r) => r.meta.id.startsWith('scroll-'));
    // At minimum: timing CV, speed profile, delta uniformity, device mode match
    expect(scrollChecks.length).toBeGreaterThanOrEqual(4);
    for (const sc of scrollChecks) {
      expect(sc.result).toHaveProperty('pass');
      expect(sc.result).toHaveProperty('actual');
    }
  });

  it('includes scroll event collection info', () => {
    const collector = cachedResults.find((r) => r.meta.id === 'scroll-deltas');
    expect(collector).toBeDefined();
    expect(collector!.result.actual).toMatch(/\d+ events collected/);
  });
});
