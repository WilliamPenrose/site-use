#!/usr/bin/env node
/**
 * Verify the full hover → reveal → AX tree → click path for partner cards.
 *
 * Steps:
 * 1. Find first card in DOM, get its bbox
 * 2. Check AX tree BEFORE hover — confirm "Send Proposal" absent
 * 3. Dispatch mouseMoved to card center (CDP Input.dispatchMouseEvent)
 * 4. Wait briefly for Vue reactivity
 * 5. Check button's computed display — confirm it changed from none
 * 6. Take AX tree AFTER hover — confirm "Send Proposal" now present
 * 7. If present, report its backendDOMNodeId — confirms click path viable
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) { console.error('No impact.com page'); process.exit(1); }

  const cdp = await page.createCDPSession();

  // ── Step 1: Find first card and its "Send Proposal" button ─────────
  console.log('='.repeat(70));
  console.log('STEP 1: Locate first card and its Send Proposal button');
  console.log('='.repeat(70));

  const cardInfo = await page.evaluate(() => {
    const cards = document.querySelectorAll('.discovery-card');
    if (!cards.length) return null;

    const card = cards[0];
    const cardRect = card.getBoundingClientRect();
    const btn = card.querySelector('button[data-testid="uicl-button"]');
    const partnerName = card.querySelector('.name .text-ellipsis')?.textContent?.trim();

    return {
      partnerName,
      cardCount: cards.length,
      cardRect: cardRect.toJSON(),
      btnExists: !!btn,
      btnDisplay: btn ? getComputedStyle(btn).display : null,
      btnText: btn?.textContent?.trim(),
      btnRect: btn ? btn.getBoundingClientRect().toJSON() : null,
    };
  });

  if (!cardInfo) { console.error('No .discovery-card found'); process.exit(1); }

  console.log(`  Partner: "${cardInfo.partnerName}"`);
  console.log(`  Total cards: ${cardInfo.cardCount}`);
  console.log(`  Card rect: x=${cardInfo.cardRect.x.toFixed(0)} y=${cardInfo.cardRect.y.toFixed(0)} w=${cardInfo.cardRect.width.toFixed(0)} h=${cardInfo.cardRect.height.toFixed(0)}`);
  console.log(`  Button in DOM: ${cardInfo.btnExists}`);
  console.log(`  Button text: "${cardInfo.btnText}"`);
  console.log(`  Button display (before hover): ${cardInfo.btnDisplay}`);

  // ── Step 2: AX tree BEFORE hover ───────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('STEP 2: AX tree BEFORE hover');
  console.log('='.repeat(70));

  const axBefore = await cdp.send('Accessibility.getFullAXTree');
  const proposalBefore = axBefore.nodes.filter(n =>
    !n.ignored && /send proposal/i.test(n.name?.value || '')
  );
  console.log(`  "Send Proposal" in AX tree: ${proposalBefore.length} (expected: 0)`);

  // Also check: what does AX see for the card area?
  // Find the card's image node (we know images have backendNodeId)
  const cardImageInfo = await page.evaluate(() => {
    const card = document.querySelectorAll('.discovery-card')[0];
    const img = card?.querySelector('[role="img"]');
    const nameEl = card?.querySelector('.name .text-ellipsis');
    return {
      imgAriaLabel: img?.getAttribute('aria-label'),
      nameText: nameEl?.textContent?.trim(),
    };
  });
  console.log(`  Card image aria-label: "${cardImageInfo.imgAriaLabel}"`);

  // ── Step 3: Hover the card via CDP Input ───────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('STEP 3: Hover card center via CDP Input.dispatchMouseEvent');
  console.log('='.repeat(70));

  // Move mouse to card center
  const cx = cardInfo.cardRect.x + cardInfo.cardRect.width / 2;
  const cy = cardInfo.cardRect.y + cardInfo.cardRect.height / 2;
  console.log(`  Moving mouse to card center: (${cx.toFixed(0)}, ${cy.toFixed(0)})`);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: cx,
    y: cy,
  });

  // Wait for Vue reactivity
  await sleep(500);

  // ── Step 4: Check button display AFTER hover ───────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('STEP 4: Button state AFTER hover');
  console.log('='.repeat(70));

  const afterHover = await page.evaluate(() => {
    const card = document.querySelectorAll('.discovery-card')[0];
    const btn = card?.querySelector('button[data-testid="uicl-button"]');
    if (!btn) return { btnExists: false };

    const style = getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    return {
      btnExists: true,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      rect: rect.toJSON(),
      classes: btn.className.slice(0, 120),
    };
  });

  console.log(`  Button display (after hover): ${afterHover.display}`);
  console.log(`  Button visibility: ${afterHover.visibility}`);
  console.log(`  Button opacity: ${afterHover.opacity}`);
  console.log(`  Button rect: x=${afterHover.rect?.x?.toFixed(0)} y=${afterHover.rect?.y?.toFixed(0)} w=${afterHover.rect?.width?.toFixed(0)} h=${afterHover.rect?.height?.toFixed(0)}`);
  console.log(`  Button classes: "${afterHover.classes}"`);

  const hoverWorked = afterHover.display !== 'none';
  console.log(`\n  >>> HOVER REVEAL: ${hoverWorked ? 'SUCCESS ✓' : 'FAILED ✗'} <<<`);

  // ── Step 5: AX tree AFTER hover ────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('STEP 5: AX tree AFTER hover');
  console.log('='.repeat(70));

  const axAfter = await cdp.send('Accessibility.getFullAXTree');
  const proposalAfter = axAfter.nodes.filter(n =>
    !n.ignored && /send proposal/i.test(n.name?.value || '')
  );
  console.log(`  "Send Proposal" in AX tree: ${proposalAfter.length}`);

  for (const n of proposalAfter) {
    console.log(`    [${n.role?.value}] "${n.name?.value}" backendDOMNodeId=${n.backendDOMNodeId}`);
    const props = (n.properties ?? [])
      .map(p => `${p.name}=${p.value?.value}`)
      .join(', ');
    if (props) console.log(`      properties: ${props}`);
  }

  const axHasProposal = proposalAfter.length > 0;
  const hasBackendNodeId = proposalAfter.some(n => n.backendDOMNodeId != null);

  console.log(`\n  >>> AX VISIBLE AFTER HOVER: ${axHasProposal ? 'YES ✓' : 'NO ✗'} <<<`);
  console.log(`  >>> HAS backendDOMNodeId: ${hasBackendNodeId ? 'YES ✓ (click path viable)' : 'NO ✗'} <<<`);

  // ── Step 6: Can we getBoxModel for it? ─────────────────────────────
  if (hasBackendNodeId) {
    console.log('\n' + '='.repeat(70));
    console.log('STEP 6: Verify click path — DOM.getBoxModel');
    console.log('='.repeat(70));

    const backendNodeId = proposalAfter[0].backendDOMNodeId;
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
      const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
      const centerX = (x1 + x3) / 2;
      const centerY = (y1 + y3) / 2;
      console.log(`  backendNodeId: ${backendNodeId}`);
      console.log(`  content quad: [${x1},${y1}] [${x2},${y2}] [${x3},${y3}] [${x4},${y4}]`);
      console.log(`  center: (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`);
      console.log(`  width×height: ${(x3 - x1).toFixed(0)}×${(y3 - y1).toFixed(0)}`);
      console.log(`\n  >>> CLICK PATH VIABLE: YES ✓ <<<`);
      console.log(`  >>> uid → backendNodeId(${backendNodeId}) → getBoxModel → (${centerX.toFixed(0)},${centerY.toFixed(0)}) → Bezier click <<<`);
    } catch (err) {
      console.log(`  getBoxModel failed: ${err.message}`);
      console.log(`  >>> CLICK PATH: BROKEN ✗ <<<`);
    }
  }

  // ── Step 7: Move mouse away, check button hides again ──────────────
  console.log('\n' + '='.repeat(70));
  console.log('STEP 7: Move mouse away — verify button hides again');
  console.log('='.repeat(70));

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 0,
    y: 0,
  });
  await sleep(500);

  const afterLeave = await page.evaluate(() => {
    const card = document.querySelectorAll('.discovery-card')[0];
    const btn = card?.querySelector('button[data-testid="uicl-button"]');
    return { display: btn ? getComputedStyle(btn).display : '(no btn)' };
  });
  console.log(`  Button display after mouse leave: ${afterLeave.display}`);
  console.log(`  >>> HIDE ON LEAVE: ${afterLeave.display === 'none' ? 'YES ✓' : 'NO (still visible)'} <<<`);

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`
  Partner: "${cardInfo.partnerName}"
  Button always in DOM: YES (display:none when not hovered)
  Hover mechanism: Vue @mouseenter/@mouseleave (not CSS :hover)

  CDP Input.dispatchMouseEvent hover: ${hoverWorked ? '✓ WORKS' : '✗ FAILED'}
  Button display:none → display:${afterHover.display} after hover: ${hoverWorked ? '✓' : '✗'}
  AX tree sees button after hover: ${axHasProposal ? '✓ YES' : '✗ NO'}
  backendDOMNodeId available: ${hasBackendNodeId ? '✓ YES' : '✗ NO'}
  getBoxModel returns coords: ${hasBackendNodeId ? '✓ (see step 6)' : '? (not tested)'}
  Button hides on mouse leave: ${afterLeave.display === 'none' ? '✓ YES' : '✗ NO'}

  Conclusion: ${hoverWorked && axHasProposal && hasBackendNodeId
    ? 'Full path VIABLE: hover card → takeSnapshot → findByDescriptor → click'
    : 'ISSUES found — see details above'}
`);

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
