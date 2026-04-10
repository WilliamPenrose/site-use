#!/usr/bin/env node
/**
 * Debug: find the scrollable container for discovery cards
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('impact.com'));
  if (!page) { console.log('No impact page'); browser.disconnect(); return; }

  // Walk up from first card to find scrollable ancestor
  const scrollInfo = await page.evaluate(() => {
    const card = document.querySelector('.discovery-card');
    if (!card) return { error: 'no card' };

    const results = [];
    let el = card.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const isScrollable = el.scrollHeight > el.clientHeight;
      const overflowY = style.overflowY;
      if (isScrollable || overflowY === 'auto' || overflowY === 'scroll') {
        results.push({
          tag: el.tagName,
          class: el.className?.toString().slice(0, 80),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
          overflowY,
          isScrollable,
        });
      }
      el = el.parentElement;
    }
    return { scrollableAncestors: results };
  });
  console.log('Scrollable ancestors:', JSON.stringify(scrollInfo, null, 2));

  // If we found one, try scrolling it
  const container = await page.evaluate(() => {
    const card = document.querySelector('.discovery-card');
    let el = card?.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 10) {
        return {
          selector: el.id ? `#${el.id}` : (el.className ? `.${el.className.split(' ')[0]}` : el.tagName),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      }
      el = el.parentElement;
    }
    return null;
  });

  if (container) {
    console.log(`\nFound container: ${container.selector} (scrollH=${container.scrollHeight}, clientH=${container.clientHeight})`);

    const before = await page.evaluate(() => document.querySelectorAll('.discovery-card').length);
    console.log(`Cards before: ${before}`);

    // Scroll the container
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) ||
        Array.from(document.querySelectorAll('*')).find(e => e.scrollHeight > e.clientHeight + 100 && e.querySelector('.discovery-card'));
      if (el) {
        el.scrollTop = el.scrollHeight;
        console.log('scrolled to', el.scrollTop);
      }
    }, container.selector);

    for (let t = 0; t < 10; t++) {
      await new Promise(r => setTimeout(r, 1000));
      const count = await page.evaluate(() => document.querySelectorAll('.discovery-card').length);
      console.log(`  t=${t+1}s: ${count} cards`);
      if (count > before) {
        console.log(`Infinite scroll worked! ${before} → ${count}`);
        break;
      }
    }
  } else {
    console.log('No scrollable container found. Trying brute force...');

    // Find ANY element with scrollHeight > clientHeight
    const allScrollable = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*'))
        .filter(el => el.scrollHeight > el.clientHeight + 50)
        .map(el => ({
          tag: el.tagName,
          class: el.className?.toString().slice(0, 60),
          id: el.id,
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
          hasCards: !!el.querySelector('.discovery-card'),
        }))
        .slice(0, 10);
    });
    console.log('All scrollable elements:', JSON.stringify(allScrollable, null, 2));
  }

  browser.disconnect();
}

main().catch(console.error);
