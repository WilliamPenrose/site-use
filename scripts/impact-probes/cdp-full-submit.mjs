#!/usr/bin/env node
/**
 * One-shot full flow: Template Term → Start Date → Partner Groups → Message → Submit → Confirm
 * With verification gate before submit.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MESSAGE = `Hello dear partner,

My name is Adam, I lead the affiliate program for OnSpace AI, and I'm reaching out via Impact because I think our platform would be a perfect fit for your network and followers. Your audience clearly trusts your recommendations for discovering new, high-value tech tools.

OnSpace AI is a no-code AI app builder. You go from idea to fully working mobile or web app in a single session. The AI handles the backend, the logic, the hosting. Your audience just builds. We're at 100,000 creators and growing fast.

We run an affiliate program, and I think you'd be a good fit, not just because the numbers are decent (20% recurring commission for 6 months), but because this is the kind of tool people in your community are already looking for and probably asking you about.

You can join directly on Impact. It takes two minutes. No special integration, no minimum commitment. A newsletter mention, a walkthrough video, a casual post - whatever fits how you already work. We look forward to having you onboard. Let me know if you have any questions.

Best regards,

Adam`;

async function getIframeDocId(cdp) {
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  function find(node) {
    if (node.nodeName === 'IFRAME' && (node.attributes ?? []).some((v, i, a) => a[i - 1] === 'src' && v.includes('proposal')))
      return node.contentDocument?.nodeId;
    for (const c of node.children ?? []) { const r = find(c); if (r) return r; }
    if (node.contentDocument) { const r = find(node.contentDocument); if (r) return r; }
    return null;
  }
  return find(doc.root);
}

async function bid(cdp, parentId, selector) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: parentId, selector });
  if (!nodeId) return null;
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  return node.backendNodeId;
}

async function click(cdp, backendNodeId) {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
  const [x1, y1, , , x3, , , y4] = model.content;
  const cx = (x1 + x3) / 2, cy = (y1 + y4) / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}

function log(label, ok, msg) { console.log(`  ${ok ? '✓' : '✗'} [${label}] ${msg}`); }

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => /impact\.com/.test(p.url()));
  const cdp = await page.createCDPSession();

  // Wait for form to be ready
  console.log('Waiting for form...');
  let iframeDocId;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      iframeDocId = await getIframeDocId(cdp);
      if (iframeDocId) {
        const ready = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[src*="proposal"]');
          const doc = iframe?.contentDocument;
          return !!doc?.querySelector('textarea[data-testid="uicl-textarea"]') &&
                 !!doc?.querySelector('button[data-testid="uicl-multi-select-input-button"]');
        });
        if (ready) { console.log(`  Form ready after ${(i+1)*500}ms`); break; }
      }
    } catch {}
  }

  const R = { templateTerm: false, startDate: false, partnerGroup: false, message: false };

  // ══════════════════════════════════════════════════════════════════
  // 1. TEMPLATE TERM → "Public Terms"
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('1. Template Term');

  // Get the first section's dropdown button via DOM path
  const { nodeId: sectionId } = await cdp.send('DOM.querySelector', { nodeId: iframeDocId, selector: 'section.iui-form-section' });
  const ttBid = await bid(cdp, sectionId, 'button[data-testid="uicl-multi-select-input-button"]');
  await click(cdp, ttBid);
  await sleep(800);

  // Find "Public Terms" in the visible dropdown
  const { nodeIds: liIds } = await cdp.send('DOM.querySelectorAll', { nodeId: iframeDocId, selector: '.iui-dropdown li, .iui-list li' });
  let ttClicked = false;
  for (const nid of liIds) {
    const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid });
    if (/Public Terms/i.test(outerHTML)) {
      const { node: liNode } = await cdp.send('DOM.describeNode', { nodeId: nid });
      try {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: liNode.backendNodeId });
        if (model.content[4] - model.content[0] > 0) {
          await click(cdp, liNode.backendNodeId);
          ttClicked = true;
          break;
        }
      } catch {}
    }
  }
  await sleep(800);

  // Verify
  const ttVal = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelector('section.iui-form-section button[data-testid="uicl-multi-select-input-button"]')?.textContent?.trim();
  });
  R.templateTerm = /public\s*terms/i.test(ttVal || '');
  log('Template Term', R.templateTerm, `"${ttVal}"`);

  // ══════════════════════════════════════════════════════════════════
  // 2. START DATE → click "Today" button in calendar
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('2. Start Date');

  // Need to re-get iframeDocId after DOM changes
  iframeDocId = await getIframeDocId(cdp);

  const dateBid = await bid(cdp, iframeDocId, 'button[data-testid="uicl-date-input"]');
  if (dateBid) {
    await click(cdp, dateBid);
    await sleep(800);

    // Look for "Today" button in the calendar
    const todayBtnBid = await (async () => {
      // Search all buttons in the calendar for one with text "Today"
      const calBid = await bid(cdp, iframeDocId, '.iui-calendar');
      if (!calBid) return null;
      const { nodeId: calNodeId } = await cdp.send('DOM.querySelector', { nodeId: iframeDocId, selector: '.iui-calendar' });
      const { nodeIds: calBtnIds } = await cdp.send('DOM.querySelectorAll', { nodeId: calNodeId, selector: 'button' });
      for (const nid of calBtnIds) {
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid });
        if (/>\s*Today\s*</i.test(outerHTML)) {
          const { node } = await cdp.send('DOM.describeNode', { nodeId: nid });
          return node.backendNodeId;
        }
      }
      return null;
    })();

    if (todayBtnBid) {
      console.log('  Found "Today" button, clicking...');
      await click(cdp, todayBtnBid);
      await sleep(500);
    } else {
      // Fallback: click the td for today's date
      console.log('  No "Today" button, clicking date cell...');
      const today = new Date().getDate().toString();
      const { nodeIds: tdIds } = await cdp.send('DOM.querySelectorAll', { nodeId: iframeDocId, selector: '.iui-calendar td' });
      for (const nid of tdIds) {
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: nid });
        if (new RegExp(`>${today}<`).test(outerHTML)) {
          const { node } = await cdp.send('DOM.describeNode', { nodeId: nid });
          try {
            const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
            if (model.content[4] - model.content[0] > 0) {
              // Click button inside td if exists
              const { nodeId: innerBtnId } = await cdp.send('DOM.querySelector', { nodeId: nid, selector: 'button' });
              if (innerBtnId) {
                const { node: innerBtn } = await cdp.send('DOM.describeNode', { nodeId: innerBtnId });
                await click(cdp, innerBtn.backendNodeId);
              } else {
                await click(cdp, node.backendNodeId);
              }
              break;
            }
          } catch {}
        }
      }
      await sleep(500);
    }
  }

  // Verify
  iframeDocId = await getIframeDocId(cdp);
  const dateVal = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelector('button[data-testid="uicl-date-input"] regular-text')?.textContent?.trim();
  });
  R.startDate = (dateVal?.length ?? 0) > 0;
  log('Start Date', R.startDate, `"${dateVal}"`);

  // ══════════════════════════════════════════════════════════════════
  // 3. PARTNER GROUPS — skip if chip exists
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('3. Partner Groups');

  const chipCount = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]')?.length ?? 0;
  });

  if (chipCount > 0) {
    console.log(`  ${chipCount} chip(s) already exist, skipping`);
    R.partnerGroup = true;
  } else {
    const tagBid = await bid(cdp, iframeDocId, 'input[data-testid="uicl-tag-input-text-input"]');
    if (tagBid) {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: tagBid });
      await sleep(200);
      await cdp.send('DOM.focus', { backendNodeId: tagBid });
      await sleep(200);
      await page.keyboard.type('Auto', { delay: 30 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(500);
      const after = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="proposal"]');
        return iframe?.contentDocument?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]')?.length ?? 0;
      });
      R.partnerGroup = after > 0;
    }
  }
  log('Partner Groups', R.partnerGroup, R.partnerGroup ? 'has chips' : 'no chips');

  // ══════════════════════════════════════════════════════════════════
  // 4. MESSAGE
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('4. Message');

  const taBid = await bid(cdp, iframeDocId, 'textarea[data-testid="uicl-textarea"]');
  if (taBid) {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: taBid });
    await sleep(200);
    await cdp.send('DOM.focus', { backendNodeId: taBid });
    await sleep(200);
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    await sleep(100);
    await page.keyboard.type(MESSAGE, { delay: 2 });
    await sleep(300);

    const val = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      return iframe?.contentDocument?.querySelector('textarea[data-testid="uicl-textarea"]')?.value?.length ?? 0;
    });
    R.message = val > 100;
  }
  log('Message', R.message, `${R.message ? 'filled' : 'empty'}`);

  // ══════════════════════════════════════════════════════════════════
  // PRE-SUBMIT GATE
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('PRE-SUBMIT GATE');
  for (const [k, v] of Object.entries(R)) console.log(`  ${v ? '✓' : '✗'} ${k}`);

  if (!Object.values(R).every(v => v)) {
    console.log('\n  ✗✗✗ ABORTING ✗✗✗');
    process.exit(1);
  }
  console.log('\n  ✓✓✓ ALL PASS → SUBMIT ✓✓✓');

  // ══════════════════════════════════════════════════════════════════
  // 5. SUBMIT
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('5. Submit');

  const submitBid = await bid(cdp, iframeDocId, 'button[data-testid="uicl-webflow-button"]');
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: submitBid });
  await sleep(300);
  await click(cdp, submitBid);
  console.log('  Clicked Submit');

  // ══════════════════════════════════════════════════════════════════
  // 6. CONFIRMATION
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('6. Confirmation (waiting 3s)');

  await sleep(3000);

  const dialogs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="modal-container"], [class*="alert-dialog"]'))
      .filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0)
      .map(el => ({
        classes: el.className?.toString().slice(0, 100),
        text: el.textContent?.trim().slice(0, 80),
        buttons: Array.from(el.querySelectorAll('button'))
          .filter(b => b.getBoundingClientRect().width > 0 && getComputedStyle(b).display !== 'none')
          .map(b => ({
            text: b.textContent?.trim(),
            rect: b.getBoundingClientRect().toJSON(),
          })),
      }));
  });

  console.log(`  Dialogs: ${dialogs.length}`);
  for (const d of dialogs) {
    console.log(`  class="${d.classes}"`);
    console.log(`  text: "${d.text}"`);
    for (const b of d.buttons) console.log(`    btn: "${b.text}" at (${Math.round(b.rect.x)},${Math.round(b.rect.y)}) ${Math.round(b.rect.width)}×${Math.round(b.rect.height)}`);
  }

  // Click the confirm button — look in confirmation-type modals first
  let confirmed = false;
  for (const d of dialogs) {
    for (const b of d.buttons) {
      if (/cancel|close/i.test(b.text)) continue;
      if (b.text && b.rect.width > 0) {
        console.log(`\n  Clicking: "${b.text}"`);
        await page.mouse.click(b.rect.x + b.rect.width / 2, b.rect.y + b.rect.height / 2);
        confirmed = true;
        break;
      }
    }
    if (confirmed) break;
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. RESULT
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('7. Result (waiting 5s)');
  await sleep(5000);

  const result = await page.evaluate(() => {
    const card = document.querySelectorAll('.discovery-card')[0];
    return {
      iframeExists: !!document.querySelector('iframe[src*="proposal"]'),
      cardName: card?.querySelector('.name .text-ellipsis')?.textContent?.trim(),
      cardBtn: card?.querySelector('button[data-testid="uicl-button"]')?.textContent?.trim(),
      badgeHtml: card?.querySelector('.badge-container')?.innerHTML?.trim().slice(0, 200),
    };
  });

  console.log(`  iframe exists: ${result.iframeExists}`);
  console.log(`  card: "${result.cardName}" btn: "${result.cardBtn}"`);
  console.log(`  badge: ${result.badgeHtml || '(empty)'}`);
  console.log(`\n  ${!result.iframeExists ? '✓✓✓ PROPOSAL SENT ✓✓✓' : '✗ iframe still open'}`);

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
