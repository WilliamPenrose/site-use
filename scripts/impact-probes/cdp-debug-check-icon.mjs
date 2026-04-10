#!/usr/bin/env node
/**
 * Debug: compare the check icon SVG color/state between sent and new cards
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

  const details = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).slice(0, 6).map((card, i) => {
      const name = card.querySelector('.name .text-ellipsis')?.textContent?.trim() ?? '';
      const idMatch = (card.querySelector('img')?.src ?? '').match(/\/(\d+)$/);
      const partnerId = idMatch ? idMatch[1] : '';

      // The add-action container with check icon
      const addAction = card.querySelector('.hover-action.add-action');
      const checkSvg = addAction?.querySelector('svg.check, svg[class*="check"]');

      let checkInfo = null;
      if (checkSvg) {
        const style = getComputedStyle(checkSvg);
        const parentStyle = getComputedStyle(addAction);
        checkInfo = {
          svgClass: checkSvg.getAttribute('class'),
          fill: style.fill,
          color: style.color,
          stroke: style.stroke,
          parentClass: addAction.className,
          parentBg: parentStyle.backgroundColor,
          parentColor: parentStyle.color,
          parentDisplay: parentStyle.display,
          // Check for data attributes
          parentDataAttrs: Array.from(addAction.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`),
          // Outer HTML of the action container
          outerHTML: addAction.outerHTML.slice(0, 300),
        };
      }

      // Also check all classes on the card itself
      const cardClasses = card.className;
      // Any data attributes on card
      const cardDataAttrs = Array.from(card.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`);

      return { i, name, partnerId, checkInfo, cardClasses, cardDataAttrs };
    });
  }, CARD_SELECTOR);

  for (const d of details) {
    console.log(`\n[${d.i}] "${d.name}" (${d.partnerId})`);
    console.log(`  Card classes: ${d.cardClasses}`);
    if (d.cardDataAttrs.length) console.log(`  Card data attrs: ${d.cardDataAttrs}`);
    if (d.checkInfo) {
      console.log(`  Check SVG: fill=${d.checkInfo.fill}, color=${d.checkInfo.color}`);
      console.log(`  Parent: bg=${d.checkInfo.parentBg}, color=${d.checkInfo.parentColor}, display=${d.checkInfo.parentDisplay}`);
      console.log(`  Parent class: ${d.checkInfo.parentClass}`);
      console.log(`  OuterHTML: ${d.checkInfo.outerHTML.slice(0, 200)}`);
    }
  }

  browser.disconnect();
}

main().catch(console.error);
