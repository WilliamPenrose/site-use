#!/usr/bin/env node
/**
 * Debug: test infinite scroll on discovery page
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const CARD_SELECTOR = '.discovery-card';

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('impact.com'));
  if (!page) { console.log('No impact page'); browser.disconnect(); return; }

  const before = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
  console.log(`Before scroll: ${before} cards`);

  // Scroll to bottom of page
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  console.log('Scrolled to bottom');

  for (let t = 0; t < 15; t++) {
    await new Promise(r => setTimeout(r, 1000));
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
    const scrollY = await page.evaluate(() => window.scrollY);
    const scrollH = await page.evaluate(() => document.body.scrollHeight);
    console.log(`  t=${t+1}s: ${count} cards, scrollY=${Math.round(scrollY)}, bodyH=${scrollH}`);
    if (count > before) {
      console.log(`New cards loaded! ${before} → ${count}`);
      break;
    }
  }

  // Try primitives-style scroll (800px down)
  console.log('\nTrying 800px scroll down...');
  const cdp = await page.createCDPSession();
  // Simulate mouse wheel
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 600, y: 400,
    deltaX: 0, deltaY: 800,
  });
  await cdp.detach();

  for (let t = 0; t < 10; t++) {
    await new Promise(r => setTimeout(r, 1000));
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
    console.log(`  t=${t+1}s: ${count} cards`);
    if (count > before) {
      console.log(`New cards loaded! ${before} → ${count}`);
      break;
    }
  }

  browser.disconnect();
}

main().catch(console.error);
