#!/usr/bin/env node
/**
 * Test: Partner Groups (skip if chip exists) → Message → Submit → Confirmation
 * Template Term + Start Date already done.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const IGNORE_FRAMES = /freshchat|wchat/;
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

async function getBackendId(cdp, parentNodeId, selector) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: parentNodeId, selector });
  if (!nodeId) return null;
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  return node.backendNodeId;
}

async function clickBid(cdp, bid) {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: bid });
  const [x1, y1, , , x3, , , y4] = model.content;
  const cx = (x1 + x3) / 2, cy = (y1 + y4) / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => /impact\.com/.test(p.url()));
  const cdp = await page.createCDPSession();
  const iframeDocId = await getIframeDocId(cdp);

  const results = { templateTerm: false, startDate: false, partnerGroup: false, message: false };

  // ── Verify Template Term ───────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('VERIFY: Template Term');
  const ttVal = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelector('section.iui-form-section button[data-testid="uicl-multi-select-input-button"]')?.textContent?.trim();
  });
  results.templateTerm = /public\s*terms/i.test(ttVal || '');
  console.log(`  "${ttVal}" → ${results.templateTerm ? '✓' : '✗'}`);

  // ── Verify Start Date ──────────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('VERIFY: Start Date');
  const dateVal = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelector('button[data-testid="uicl-date-input"] regular-text')?.textContent?.trim();
  });
  results.startDate = (dateVal?.length ?? 0) > 0; // "Apr 9, 2026"
  console.log(`  "${dateVal}" → ${results.startDate ? '✓' : '✗'}`);

  // ── Partner Groups: skip if chip exists, else add "Auto" ───────────
  console.log('═'.repeat(70));
  console.log('STEP: Partner Groups');
  console.log('═'.repeat(70));

  const chipExists = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    const container = iframe?.contentDocument?.querySelector('[data-testid="uicl-tag-input"]');
    const chips = container?.querySelectorAll('[data-testid^="uicl-tag-input-"][data-testid$="-delete-icon"], [data-testid^="uicl-tag-input-"]:not([data-testid="uicl-tag-input-text-input"]):not([data-testid="uicl-tag-input"])') ?? [];
    // Simpler: check if there's a span with delete icon
    const deleteIcons = container?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]') ?? [];
    return {
      count: deleteIcons.length,
      texts: Array.from(deleteIcons).map(icon => icon.closest('span')?.textContent?.trim().slice(0, 40)),
    };
  });

  console.log(`  Existing chips: ${chipExists.count} → ${chipExists.texts.join(', ')}`);

  if (chipExists.count > 0) {
    console.log('  Chips already exist, skipping "Auto" input ✓');
    results.partnerGroup = true;
  } else {
    console.log('  No chips, adding "Auto"...');
    const tagBid = await getBackendId(cdp, iframeDocId, 'input[data-testid="uicl-tag-input-text-input"]');
    if (tagBid) {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: tagBid });
      await sleep(200);
      await cdp.send('DOM.focus', { backendNodeId: tagBid });
      await sleep(200);
      await page.keyboard.type('Auto', { delay: 30 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(500);

      // Verify
      const after = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="proposal"]');
        const container = iframe?.contentDocument?.querySelector('[data-testid="uicl-tag-input"]');
        const icons = container?.querySelectorAll('[data-testid="uicl-tag-input-delete-icon"]') ?? [];
        return icons.length;
      });
      results.partnerGroup = after > 0;
      console.log(`  Chips after: ${after} → ${results.partnerGroup ? '✓' : '✗'}`);
    }
  }

  // ── Message ────────────────────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('STEP: Message');
  console.log('═'.repeat(70));

  const taBid = await getBackendId(cdp, iframeDocId, 'textarea[data-testid="uicl-textarea"]');
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
    await sleep(500);

    const val = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      return iframe?.contentDocument?.querySelector('textarea[data-testid="uicl-textarea"]')?.value?.slice(0, 40);
    });
    results.message = (val?.length ?? 0) > 20;
    console.log(`  "${val}..." → ${results.message ? '✓' : '✗'}`);
  }

  // ── Pre-submit gate ────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('PRE-SUBMIT VERIFICATION');
  console.log('═'.repeat(70));
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? '✓' : '✗'} ${k}`);

  if (!Object.values(results).every(v => v)) {
    console.log('\n  ✗✗✗ ABORTING ✗✗✗');
    process.exit(1);
  }
  console.log('\n  ✓✓✓ All passed — submitting ✓✓✓');

  // ── Submit ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('SUBMIT');
  console.log('═'.repeat(70));

  const submitBid = await getBackendId(cdp, iframeDocId, 'button[data-testid="uicl-webflow-button"]');
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: submitBid });
  await sleep(300);
  await clickBid(cdp, submitBid);
  console.log('  Clicked Submit ✓');

  // ── Wait for confirmation dialog ───────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('CONFIRMATION DIALOG (waiting 3s)');
  console.log('═'.repeat(70));

  await sleep(3000);

  // Dump all visible dialogs and their buttons
  const dialogs = await page.evaluate(() => {
    const results = [];
    for (const el of document.querySelectorAll('[class*="modal-container"], [class*="alert-dialog"], [role="dialog"]')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const btns = Array.from(el.querySelectorAll('button')).filter(b => {
        const br = b.getBoundingClientRect();
        return br.width > 0 && getComputedStyle(b).display !== 'none';
      }).map(b => ({
        text: b.textContent?.trim(),
        testId: b.getAttribute('data-testid'),
        rect: b.getBoundingClientRect().toJSON(),
      }));
      results.push({
        classes: el.className?.toString().slice(0, 100),
        text: el.textContent?.trim().slice(0, 100),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        buttons: btns,
      });
    }
    return results;
  });

  console.log(`  Visible dialogs: ${dialogs.length}`);
  for (const d of dialogs) {
    console.log(`\n  class="${d.classes}"`);
    console.log(`  text: "${d.text}"`);
    console.log(`  rect: ${JSON.stringify(d.rect)}`);
    console.log(`  buttons:`);
    for (const b of d.buttons) {
      console.log(`    "${b.text}" testId="${b.testId}" rect=(${Math.round(b.rect.x)},${Math.round(b.rect.y)}) ${Math.round(b.rect.width)}×${Math.round(b.rect.height)}`);
    }
  }

  // ── Click confirm ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('CLICK CONFIRM');
  console.log('═'.repeat(70));

  let confirmed = false;
  // Strategy: find the "confirmation" modal's non-cancel button
  for (const d of dialogs) {
    if (!/confirm/i.test(d.classes)) continue;
    for (const b of d.buttons) {
      if (/cancel|close/i.test(b.text)) continue;
      if (b.rect.width > 0) {
        console.log(`  Clicking "${b.text}" in confirmation modal`);
        await page.mouse.click(b.rect.x + b.rect.width / 2, b.rect.y + b.rect.height / 2);
        confirmed = true;
        break;
      }
    }
    if (confirmed) break;
  }

  // Fallback: look for any "Ok" or "Send" button
  if (!confirmed) {
    for (const d of dialogs) {
      for (const b of d.buttons) {
        if (/^(ok|send|confirm|yes|propose)$/i.test(b.text) && b.rect.width > 0) {
          console.log(`  Fallback: clicking "${b.text}"`);
          await page.mouse.click(b.rect.x + b.rect.width / 2, b.rect.y + b.rect.height / 2);
          confirmed = true;
          break;
        }
      }
      if (confirmed) break;
    }
  }

  if (!confirmed) {
    console.log('  ✗ No confirm button found');
    // Dump ALL visible buttons on page for debugging
    const allBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(b).display !== 'none';
      }).map(b => ({
        text: b.textContent?.trim().slice(0, 30),
        rect: { x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y) },
      }));
    });
    console.log('  All visible buttons:');
    for (const b of allBtns) console.log(`    "${b.text}" at (${b.rect.x},${b.rect.y})`);
  } else {
    console.log('  Clicked confirm ✓');
  }

  // ── Result ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('RESULT (waiting 5s)');
  console.log('═'.repeat(70));

  await sleep(5000);

  const result = await page.evaluate(() => {
    const iframeExists = !!document.querySelector('iframe[src*="proposal"]');
    const firstCard = document.querySelectorAll('.discovery-card')[0];
    const firstBtn = firstCard?.querySelector('button[data-testid="uicl-button"]');

    // Check for any badge/status change on first card
    const badge = firstCard?.querySelector('.badge-container');

    return {
      iframeExists,
      firstCardName: firstCard?.querySelector('.name .text-ellipsis')?.textContent?.trim(),
      firstCardBtnText: firstBtn?.textContent?.trim(),
      firstCardBadge: badge?.textContent?.trim() || '(empty)',
      firstCardBadgeHtml: badge?.innerHTML?.slice(0, 200),
    };
  });

  console.log(`  iframe exists: ${result.iframeExists}`);
  console.log(`  first card: "${result.firstCardName}"`);
  console.log(`  first card button: "${result.firstCardBtnText}"`);
  console.log(`  first card badge: "${result.firstCardBadge}"`);
  console.log(`  badge html: ${result.firstCardBadgeHtml}`);
  console.log(`\n  ${!result.iframeExists ? '✓ PROPOSAL SENT (iframe closed)' : '✗ iframe still open'}`);

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
