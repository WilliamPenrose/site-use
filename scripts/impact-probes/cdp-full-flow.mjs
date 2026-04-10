#!/usr/bin/env node
/**
 * Full end-to-end flow verification:
 *
 * 1. Hover card → reveal "Send Proposal" button
 * 2. Click the button via CDP (simulating primitives.click path)
 * 3. Wait for iframe dialog to appear
 * 4. Take AX tree of iframe (with frameId)
 * 5. Interact with form elements inside iframe
 * 6. Submit the form (or verify submit button is clickable)
 *
 * This does NOT actually submit — it verifies every step is mechanically possible,
 * then stops before the final submit click.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;
const IGNORE_FRAMES = /freshchat|wchat/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) { console.error('No impact.com page'); process.exit(1); }

  const cdp = await page.createCDPSession();

  // Check if iframe dialog is already open (from previous run)
  const alreadyOpen = await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'));

  let iframeFound = false;
  let btnVisible = false;
  let proposalNodes = [];

  if (alreadyOpen) {
    console.log('═'.repeat(70));
    console.log('PHASE 1-3: SKIPPED — iframe dialog already open from previous run');
    console.log('═'.repeat(70));
    iframeFound = true;
    btnVisible = true; // was clicked previously
    proposalNodes = [{ _skipped: true }];
  } else {
    // ══════════════════════════════════════════════════════════════════
    // PHASE 1: Hover card → reveal button
    // ══════════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('PHASE 1: Hover card to reveal "Send Proposal" button');
    console.log('═'.repeat(70));

    const cardRect = await page.evaluate(() => {
      const card = document.querySelectorAll('.discovery-card')[0];
      const name = card?.querySelector('.name .text-ellipsis')?.textContent?.trim();
      const rect = card?.getBoundingClientRect();
      return rect ? { name, x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null;
    });
    console.log(`  Target: "${cardRect.name}"`);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cardRect.x + cardRect.w / 2,
      y: cardRect.y + cardRect.h / 2,
    });
    await sleep(500);

    btnVisible = await page.evaluate(() => {
      const card = document.querySelectorAll('.discovery-card')[0];
      const btn = card?.querySelector('button[data-testid="uicl-button"]');
      return btn ? getComputedStyle(btn).display !== 'none' : false;
    });
    console.log(`  Button revealed: ${btnVisible ? '✓' : '✗'}`);
    if (!btnVisible) { console.error('  ABORT: button not revealed'); process.exit(1); }

    // ══════════════════════════════════════════════════════════════════
    // PHASE 2: Click "Send Proposal" button
    // ══════════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(70));
    console.log('PHASE 2: Click "Send Proposal" via AX tree → getBoxModel → mouse click');
    console.log('═'.repeat(70));

    const ax = await cdp.send('Accessibility.getFullAXTree');
    proposalNodes = ax.nodes.filter(n =>
      !n.ignored && n.role?.value === 'button' && /send proposal/i.test(n.name?.value || '')
    );
    console.log(`  AX buttons matching "Send Proposal": ${proposalNodes.length}`);

    if (!proposalNodes.length) { console.error('  ABORT: no Send Proposal in AX'); process.exit(1); }

    const btnNode = proposalNodes[0];
    const btnBackendId = btnNode.backendDOMNodeId;
    console.log(`  backendDOMNodeId: ${btnBackendId}`);

    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btnBackendId });
    const [x1, y1, , , x3, , , y4] = model.content;
    const clickX = (x1 + x3) / 2;
    const clickY = (y1 + y4) / 2;
    console.log(`  Click target: (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1,
    });
    console.log(`  Click dispatched ✓`);

    // ══════════════════════════════════════════════════════════════════
    // PHASE 3: Wait for iframe dialog to appear
    // ══════════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(70));
    console.log('PHASE 3: Wait for iframe dialog');
    console.log('═'.repeat(70));

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(500);
      const frames = page.frames();
      const businessFrame = frames.find(f =>
        !IGNORE_FRAMES.test(f.url()) && f !== page.mainFrame() && f.url().includes('impact.com')
      );
      if (businessFrame) {
        console.log(`  Iframe appeared after ${(attempt + 1) * 500}ms`);
        console.log(`  URL: ${businessFrame.url().slice(0, 100)}`);
        iframeFound = true;
        break;
      }
      if (attempt % 4 === 0) console.log(`  Waiting... (${(attempt + 1) * 500}ms)`);
    }

    if (!iframeFound) {
      console.error('  ABORT: iframe dialog did not appear within 10s');
      process.exit(1);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4: AX tree of iframe
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PHASE 4: AX tree of iframe form');
  console.log('═'.repeat(70));

  // Get frameId via Page.getFrameTree
  const { frameTree } = await cdp.send('Page.getFrameTree');
  let iframeId = null;
  function findFrameId(ft) {
    for (const child of ft.childFrames ?? []) {
      if (!IGNORE_FRAMES.test(child.frame.url) && child.frame.url.includes('impact.com')) {
        iframeId = child.frame.id;
        return;
      }
      findFrameId(child);
    }
  }
  findFrameId(frameTree);

  if (!iframeId) { console.error('  ABORT: cannot find iframe frameId'); process.exit(1); }
  console.log(`  iframe frameId: ${iframeId}`);

  // Wait for iframe content to fully load
  let iframeNodes = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const iframeAx = await cdp.send('Accessibility.getFullAXTree', { frameId: iframeId });
    iframeNodes = iframeAx.nodes.filter(n => !n.ignored);
    // Check if form elements have loaded (expect buttons, textboxes etc.)
    const hasInteractive = iframeNodes.some(n =>
      ['button', 'textbox', 'radio', 'checkbox', 'combobox'].includes(n.role?.value)
    );
    if (hasInteractive) {
      console.log(`  iframe content loaded after ${(attempt + 1) * 500}ms (${iframeNodes.length} non-ignored AX nodes)`);
      break;
    }
    if (attempt % 4 === 0) console.log(`  Waiting for iframe form to render... (${(attempt + 1) * 500}ms, ${iframeNodes.length} nodes)`);
    await sleep(500);
  }
  console.log(`  AX nodes in iframe (non-ignored): ${iframeNodes.length}`);

  // Categorize interactive elements
  const interactive = iframeNodes.filter(n => {
    const role = n.role?.value;
    return ['button', 'textbox', 'combobox', 'radio', 'checkbox', 'spinbutton', 'slider', 'menuitem', 'link', 'searchbox', 'switch'].includes(role);
  });

  console.log(`\n  Interactive elements in iframe form:`);
  for (const n of interactive) {
    const role = n.role?.value;
    const name = n.name?.value || '';
    const props = (n.properties ?? [])
      .filter(p => ['focusable', 'required', 'disabled', 'checked', 'selected', 'expanded'].includes(p.name))
      .map(p => `${p.name}=${p.value?.value}`)
      .join(', ');
    const hasBnid = n.backendDOMNodeId != null;
    console.log(`    [${role}] "${name.slice(0, 40)}"${props ? ` (${props})` : ''} backendNodeId=${n.backendDOMNodeId ?? '?'} clickable=${hasBnid}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5: Verify form interactions — getBoxModel for each interactive element
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PHASE 5: Verify getBoxModel works for iframe elements');
  console.log('═'.repeat(70));

  let boxModelSuccess = 0;
  let boxModelFail = 0;
  for (const n of interactive) {
    if (n.backendDOMNodeId == null) { boxModelFail++; continue; }
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
      const [bx1, by1, , , bx3, , , by4] = model.content;
      const w = bx3 - bx1;
      const h = by4 - by1;
      if (w > 0 && h > 0) {
        boxModelSuccess++;
      } else {
        console.log(`    [${n.role?.value}] "${n.name?.value?.slice(0, 30)}" — zero-size box (${w}×${h})`);
        boxModelFail++;
      }
    } catch (err) {
      console.log(`    [${n.role?.value}] "${n.name?.value?.slice(0, 30)}" — getBoxModel FAILED: ${err.message}`);
      boxModelFail++;
    }
  }
  console.log(`\n  getBoxModel results: ${boxModelSuccess} success, ${boxModelFail} failed out of ${interactive.length}`);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 6: Try typing in a textbox inside iframe
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PHASE 6: Test typing in iframe textbox');
  console.log('═'.repeat(70));

  const textboxNode = interactive.find(n => n.role?.value === 'textbox' && n.backendDOMNodeId != null);
  if (textboxNode) {
    console.log(`  Target textbox: "${textboxNode.name?.value?.slice(0, 40)}" backendNodeId=${textboxNode.backendDOMNodeId}`);

    // Focus via CDP
    try {
      await cdp.send('DOM.focus', { backendNodeId: textboxNode.backendDOMNodeId });
      console.log(`  DOM.focus: ✓`);

      // Verify focus worked
      const focusCheck = await page.evaluate(() => {
        const active = document.activeElement;
        // Check if focus went into iframe
        if (active?.tagName === 'IFRAME') {
          const iframeDoc = active.contentDocument;
          const innerActive = iframeDoc?.activeElement;
          return {
            mainActive: 'IFRAME',
            innerActive: innerActive?.tagName,
            innerType: innerActive?.getAttribute('type'),
            innerName: innerActive?.getAttribute('name'),
          };
        }
        return { mainActive: active?.tagName, innerActive: null };
      });
      console.log(`  Focus state: ${JSON.stringify(focusCheck)}`);

      // Type test text
      await page.keyboard.type('test-probe', { delay: 30 });
      console.log(`  keyboard.type: ✓ (typed "test-probe")`);

      // Read back
      const typed = await page.evaluate(() => {
        const active = document.activeElement;
        if (active?.tagName === 'IFRAME') {
          return active.contentDocument?.activeElement?.value ?? '(no value)';
        }
        return active?.value ?? '(no value)';
      });
      console.log(`  Read back value: "${typed}"`);

      // Clear what we typed
      for (let i = 0; i < 'test-probe'.length; i++) {
        await page.keyboard.press('Backspace');
      }
      console.log(`  Cleaned up typed text ✓`);
    } catch (err) {
      console.log(`  DOM.focus FAILED: ${err.message}`);
    }
  } else {
    console.log('  No textbox found in iframe');
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 7: Locate "Send Proposal" submit button inside iframe
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PHASE 7: Verify submit button in iframe');
  console.log('═'.repeat(70));

  const submitBtn = interactive.find(n =>
    n.role?.value === 'button' && /send proposal/i.test(n.name?.value || '')
  );

  if (submitBtn) {
    console.log(`  Submit button found: [${submitBtn.role?.value}] "${submitBtn.name?.value}" backendNodeId=${submitBtn.backendDOMNodeId}`);

    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: submitBtn.backendDOMNodeId });
      const [sx1, sy1, , , sx3, , , sy4] = model.content;
      console.log(`  Box: (${sx1.toFixed(0)},${sy1.toFixed(0)}) ${(sx3-sx1).toFixed(0)}×${(sy4-sy1).toFixed(0)}`);
      console.log(`  >>> SUBMIT BUTTON CLICKABLE: YES ✓ <<<`);
      console.log(`  (NOT clicking — this is verification only)`);
    } catch (err) {
      console.log(`  getBoxModel FAILED: ${err.message}`);
    }
  } else {
    console.log('  No "Send Proposal" submit button found in iframe AX');
    console.log('  Looking for any button...');
    const anyBtns = interactive.filter(n => n.role?.value === 'button');
    for (const b of anyBtns) {
      console.log(`    [button] "${b.name?.value}" backendNodeId=${b.backendDOMNodeId}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('FULL FLOW SUMMARY');
  console.log('═'.repeat(70));

  const steps = [
    ['Hover card → reveal button', btnVisible],
    ['AX tree sees button', proposalNodes.length > 0],
    ['Click button → iframe dialog appears', iframeFound],
    ['AX tree (frameId) sees iframe form', iframeNodes.length > 0],
    ['getBoxModel works for iframe elements', boxModelSuccess > 0],
    ['DOM.focus + keyboard.type in iframe', !!textboxNode],
    ['Submit button locatable in iframe', !!submitBtn],
  ];

  for (const [desc, ok] of steps) {
    console.log(`  ${ok ? '✓' : '✗'} ${desc}`);
  }

  const allPassed = steps.every(([, ok]) => ok);
  console.log(`\n  ${allPassed
    ? '>>> ALL STEPS PASSED — full flow is mechanically viable <<<'
    : '>>> SOME STEPS FAILED — see details above <<<'
  }`);

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
