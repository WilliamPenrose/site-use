#!/usr/bin/env node
/**
 * Debug: replicate EXACTLY what form-filler.ts fillPartnerGroup does,
 * with logging at each step. Dialog left open.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const CARD_SELECTOR = '.discovery-card';
const IFRAME_SELECTOR = 'iframe[src*="proposal"]';

function findIframeDocId(root) {
  if (root.nodeName === 'IFRAME') {
    const attrs = root.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === 'src' && attrs[i + 1]?.includes('proposal')) return root.contentDocument?.nodeId ?? null;
    }
  }
  for (const child of root.children ?? []) { const r = findIframeDocId(child); if (r) return r; }
  if (root.contentDocument) { const r = findIframeDocId(root.contentDocument); if (r) return r; }
  return null;
}

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => p.url().includes('impact.com'));
  if (!page) { console.log('No impact page'); browser.disconnect(); return; }
  const cdp = await page.createCDPSession();

  // Close existing dialog
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 1500));

  // Try cards from index 3 onwards (first few may be sent)
  const cardIdx = parseInt(process.argv[2] ?? '3', 10);
  if (cardIdx < 0) { console.log('No unsent card'); await cdp.detach(); browser.disconnect(); return; }
  console.log(`Card ${cardIdx}: "${await page.evaluate((sel, i) => document.querySelectorAll(sel)[i].querySelector('.name .text-ellipsis')?.textContent?.trim(), CARD_SELECTOR, cardIdx)}"`);

  // Hover + open dialog
  const rect = await page.evaluate((sel, i) => {
    const card = document.querySelectorAll(sel)[i];
    card.scrollIntoView({ block: 'center' });
    const r = card.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, CARD_SELECTOR, cardIdx);
  await new Promise(r => setTimeout(r, 300));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await new Promise(r => setTimeout(r, 100));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await new Promise(r => setTimeout(r, 800));
  const btnRect = await page.evaluate((sel, i) => {
    const btn = document.querySelectorAll(sel)[i].querySelector('button[data-testid="uicl-button"]');
    if (!btn || getComputedStyle(btn).display === 'none') return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, CARD_SELECTOR, cardIdx);
  if (!btnRect) { console.log('No button'); await cdp.detach(); browser.disconnect(); return; }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnRect.x, y: btnRect.y });
  await new Promise(r => setTimeout(r, 50));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 });

  for (let t = 0; t < 30; t++) {
    await new Promise(r => setTimeout(r, 500));
    const ready = await page.evaluate((sel) => !!document.querySelector(sel)?.contentDocument?.querySelector('input[data-testid="uicl-tag-input-text-input"]'), IFRAME_SELECTOR);
    if (ready) { console.log(`Form ready`); break; }
  }

  // ─── Replicate fillPartnerGroup exactly ───
  const value = 'Auto';

  // Step 1: check existing chips
  const chipsBefore = await page.evaluate((sel) => {
    const iframe = document.querySelector(sel);
    return iframe?.contentDocument?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]')?.length ?? 0;
  }, IFRAME_SELECTOR);
  console.log(`1. Chips before: ${chipsBefore}`);
  if (chipsBefore > 0) { console.log('Already has chips, would skip'); await cdp.detach(); browser.disconnect(); return; }

  // Step 2: CDP focus (same as form-filler.ts)
  console.log('2. CDP focus on tag input...');
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const iframeDocId = findIframeDocId(doc.root);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: iframeDocId, selector: 'input[data-testid="uicl-tag-input-text-input"]' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
  await new Promise(r => setTimeout(r, 200));
  await cdp.send('DOM.focus', { backendNodeId: node.backendNodeId });
  await new Promise(r => setTimeout(r, 200));

  // Step 3: type (same delay as form-filler.ts)
  console.log(`3. Typing "${value}" with delay 80...`);
  await page.keyboard.type(value, { delay: 80 });
  console.log('4. Waiting 2s for autocomplete...');
  await new Promise(r => setTimeout(r, 2000));

  // Step 5: check if dropdown appeared
  const dropdown = await page.evaluate((sel) => {
    const iframe = document.querySelector(sel);
    const dd = iframe?.contentDocument?.querySelector('[data-testid="uicl-tag-input-dropdown"]');
    if (!dd || getComputedStyle(dd).display === 'none') return null;
    return Array.from(dd.querySelectorAll('li[role="option"]')).map(li => li.textContent?.trim());
  }, IFRAME_SELECTOR);
  console.log(`5. Autocomplete dropdown items: ${JSON.stringify(dropdown)}`);

  // Step 6: AX snapshot to find option (same as form-filler.ts)
  console.log('6. Taking AX snapshot to find option...');
  // Use per-frame AX to simulate what M1 takeSnapshot does
  const { frameTree } = await cdp.send('Page.getFrameTree');
  let iframeFrameId = null;
  for (const cf of (frameTree.childFrames ?? [])) {
    if (cf.frame.url.includes('proposal')) { iframeFrameId = cf.frame.id; break; }
  }

  if (iframeFrameId) {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: iframeFrameId });
    const options = nodes.filter(n => n.role?.value === 'option' && /auto/i.test(n.name?.value ?? ''));
    console.log(`   Iframe AX options: ${options.map(o => `"${o.name?.value}" bid=${o.backendDOMNodeId}`).join(', ') || 'NONE'}`);

    if (options.length > 0) {
      // Step 7: click via getBoxModel (what primitives.click does)
      const opt = options[0];
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: opt.backendDOMNodeId });
      const [x1, y1, , , x3, , , y4] = model.content;
      const cx = (x1 + x3) / 2, cy = (y1 + y4) / 2;
      console.log(`7. Clicking option at (${cx}, ${cy})...`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await new Promise(r => setTimeout(r, 50));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    console.log('   No iframe frame found');
  }

  // Step 8: verify
  const chipsAfter = await page.evaluate((sel) => {
    const iframe = document.querySelector(sel);
    return iframe?.contentDocument?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]')?.length ?? 0;
  }, IFRAME_SELECTOR);
  console.log(`8. Chips after: ${chipsAfter} ${chipsAfter > chipsBefore ? '✅' : '❌'}`);

  console.log('\n>>> Dialog left open. <<<');
  await cdp.detach();
  browser.disconnect();
}

main().catch(console.error);
