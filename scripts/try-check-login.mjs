/**
 * Quick script to try checkLogin manually.
 *
 * Usage:
 *   1. pnpm run build
 *   2. node scripts/try-check-login.mjs
 *
 * Make sure you're logged in to x.com in the site-use Chrome profile first:
 *   site-use browser launch
 *   (log in manually in the Chrome window, then Ctrl+C)
 */
import { ensureBrowser } from '../dist/browser/browser.js';
import { PuppeteerBackend } from '../dist/primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../dist/primitives/throttle.js';
import { checkLogin } from '../dist/sites/twitter/workflows.js';

const browser = await ensureBrowser();
const backend = new PuppeteerBackend(browser);
const primitives = createThrottledPrimitives(backend, {
  minDelay: 500,
  maxDelay: 1000,
});

console.log('Checking Twitter login status...');
const result = await checkLogin(primitives);
console.log('Result:', JSON.stringify(result, null, 2));

process.exit(0);
