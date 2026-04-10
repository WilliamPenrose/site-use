#!/usr/bin/env node
/**
 * Debug: hover a SENT card and a NEW card, compare visible elements
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const CARD_SELECTOR = '.discovery-card';

async function inspectCard(page, cdp, index, label) {
  // Scroll into view + hover
  const rect = await page.evaluate((sel, i) => {
    const card = document.querySelectorAll(sel)[i];
    card.scrollIntoView({ block: 'center' });
    const r = card.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, CARD_SELECTOR, index);
  await new Promise(r => setTimeout(r, 300));

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await new Promise(r => setTimeout(r, 100));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await new Promise(r => setTimeout(r, 800));

  const info = await page.evaluate((sel, i) => {
    const card = document.querySelectorAll(sel)[i];

    // All visible elements (not display:none)
    const visible = [];
    card.querySelectorAll('*').forEach(el => {
      const style = getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        // Only elements with useful info
        if (el.classList.length > 0 && (
          el.classList.toString().includes('hover') ||
          el.classList.toString().includes('action') ||
          el.classList.toString().includes('check') ||
          el.classList.toString().includes('status') ||
          el.classList.toString().includes('badge') ||
          el.classList.toString().includes('button') ||
          el.tagName === 'BUTTON'
        )) {
          visible.push({
            tag: el.tagName,
            class: el.className?.toString().slice(0, 80),
            text: el.textContent?.trim().slice(0, 30),
            display: style.display,
            color: style.color,
            bgColor: style.backgroundColor,
          });
        }
      }
    });

    // Check the hover-action area specifically
    const hoverActions = card.querySelectorAll('.hover-action');
    const hoverInfo = Array.from(hoverActions).map(ha => ({
      class: ha.className,
      visible: getComputedStyle(ha).display !== 'none',
      children: Array.from(ha.children).map(c => ({
        tag: c.tagName,
        class: c.className?.toString().slice(0, 60),
        visible: getComputedStyle(c).display !== 'none',
        title: c.getAttribute('title') || '',
      })),
    }));

    // Check the button specifically
    const btn = card.querySelector('button[data-testid="uicl-button"]');
    const btnInfo = btn ? {
      text: btn.textContent?.trim(),
      display: getComputedStyle(btn).display,
      disabled: btn.disabled,
    } : null;

    return { visible: visible.slice(0, 15), hoverActions: hoverInfo, button: btnInfo };
  }, CARD_SELECTOR, index);

  console.log(`\n═══ [${index}] ${label} ═══`);
  console.log('  Button:', JSON.stringify(info.button));
  console.log('  Hover actions:');
  for (const ha of info.hoverActions) {
    console.log(`    ${ha.class} visible=${ha.visible}`);
    for (const c of ha.children) {
      console.log(`      <${c.tag}> class="${c.class}" visible=${c.visible} title="${c.title}"`);
    }
  }
}

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(join(homedir(), '.site-use', 'chrome.json'), 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('impact.com'));
  const cdp = await page.createCDPSession();

  await inspectCard(page, cdp, 0, 'SENT: like where youre going');
  await inspectCard(page, cdp, 3, 'NEW: Global Viewpoint');

  await cdp.detach();
  browser.disconnect();
}

main().catch(console.error);
