#!/usr/bin/env node
/**
 * Final form test — each control tested independently.
 * After each test, verify iframe is still alive before next test.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'os';
import { join } from 'path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const IGNORE_FRAMES = /freshchat|wchat/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureDialog(page, cdp) {
  if (await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'))) return true;
  console.log('  [re-opening dialog...]');
  const card = await page.evaluate(() => {
    const c = document.querySelectorAll('.discovery-card')[0];
    const r = c?.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
  await sleep(500);
  const ax = await cdp.send('Accessibility.getFullAXTree');
  const btn = ax.nodes.find(n => !n.ignored && n.role?.value === 'button' && /send proposal/i.test(n.name?.value || ''));
  if (!btn) return false;
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendDOMNodeId });
  const [x1, y1, , , x3, , , y4] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y4) / 2);
  for (let i = 0; i < 20; i++) { await sleep(500); if (await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'))) { await sleep(2000); return true; } }
  return false;
}

async function getFrameId(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  let id = null;
  (function f(ft) { for (const c of ft.childFrames ?? []) { if (!IGNORE_FRAMES.test(c.frame.url) && c.frame.url.includes('impact.com')) { id = c.frame.id; return; } f(c); } })(frameTree);
  return id;
}

async function getAx(cdp) {
  const fid = await getFrameId(cdp);
  if (!fid) return [];
  for (let i = 0; i < 15; i++) {
    try {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: fid });
      const live = nodes.filter(n => !n.ignored);
      if (live.some(n => ['button', 'textbox', 'radio', 'checkbox'].includes(n.role?.value))) return live;
    } catch {}
    await sleep(500);
  }
  return [];
}

function prop(n, name) { return (n.properties ?? []).find(p => p.name === name)?.value?.value; }

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => /impact\.com/.test(p.url()));
  const cdp = await page.createCDPSession();
  const R = [];
  const log = (t, ok, m) => { console.log(`  ${ok ? '✓' : '✗'} ${m}`); R.push({ t, ok, m }); };

  await ensureDialog(page, cdp);

  // ── 1. RADIO ───────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('1. RADIO BUTTONS');
  console.log('═'.repeat(70));
  let ax = await getAx(cdp);
  const radios = ax.filter(n => n.role?.value === 'radio');
  console.log(`  Found: ${radios.length}`);
  for (const r of radios) console.log(`    checked=${prop(r, 'checked')} disabled=${prop(r, 'disabled')} bid=${r.backendDOMNodeId}`);

  const ucRadio = radios.find(r => prop(r, 'checked') === false && !prop(r, 'disabled'));
  if (ucRadio) {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: ucRadio.backendDOMNodeId });
    const [x1, y1, , , x3, , , y4] = model.content;
    await page.mouse.click((x1 + x3) / 2, (y1 + y4) / 2);
    await sleep(300);
    ax = await getAx(cdp);
    const up = ax.find(n => n.backendDOMNodeId === ucRadio.backendDOMNodeId);
    log('Radio', prop(up, 'checked') === true, `Toggle: false → ${prop(up, 'checked')}`);
  } else log('Radio', false, 'No unchecked+enabled radio');

  // ── 2. CHECKBOX ────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('2. CHECKBOXES');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);
  ax = await getAx(cdp);
  const cbs = ax.filter(n => n.role?.value === 'checkbox');
  console.log(`  Found: ${cbs.length}`);
  for (const cb of cbs) console.log(`    checked=${prop(cb, 'checked')} bid=${cb.backendDOMNodeId}`);

  if (cbs.length > 0) {
    const cb = cbs[0];
    const was = prop(cb, 'checked');
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: cb.backendDOMNodeId });
    const [x1, y1, , , x3, , , y4] = model.content;
    await page.mouse.click((x1 + x3) / 2, (y1 + y4) / 2);
    await sleep(300);
    ax = await getAx(cdp);
    const up = ax.find(n => n.backendDOMNodeId === cb.backendDOMNodeId);
    const now = prop(up, 'checked');
    log('Checkbox', now !== was, `Toggle: ${was} → ${now}`);
    // Undo
    await page.mouse.click((x1 + x3) / 2, (y1 + y4) / 2);
    await sleep(200);
  }

  // ── 3. TEXTAREA ────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('3. TEXTAREA (Message)');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);
  ax = await getAx(cdp);
  const msgTb = ax.find(n => n.role?.value === 'textbox' && n.backendDOMNodeId != null && !/[`~]/.test(n.value?.value || ''));
  if (msgTb) {
    console.log(`  textbox bid=${msgTb.backendDOMNodeId}`);
    await cdp.send('DOM.focus', { backendNodeId: msgTb.backendDOMNodeId });
    await sleep(200);
    const txt = 'Hello CDP';
    await page.keyboard.type(txt, { delay: 15 });
    await sleep(200);
    const val = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      return iframe?.contentDocument?.activeElement?.value ?? '';
    });
    log('Textarea', val.includes(txt), `Type "${txt}" → readback "${val.slice(0, 30)}"`);
    for (let i = 0; i < txt.length; i++) await page.keyboard.press('Backspace');
  } else log('Textarea', false, 'No suitable textbox found');

  // ── 4. TAG INPUT ───────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('4. TAG INPUT (Partner Groups)');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);
  // Focus via DOM since it might not be in AX tree
  await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    iframe?.contentDocument?.querySelector('input[data-testid="uicl-tag-input-text-input"]')?.focus();
  });
  await sleep(200);
  const tag = 'test';
  await page.keyboard.type(tag, { delay: 15 });
  await sleep(200);
  const tagVal = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    return iframe?.contentDocument?.querySelector('input[data-testid="uicl-tag-input-text-input"]')?.value ?? '';
  });
  log('Tag Input', tagVal.includes(tag), `Type "${tag}" → readback "${tagVal}"`);
  for (let i = 0; i < tag.length; i++) await page.keyboard.press('Backspace');

  // ── 5. DROPDOWN: Template Term ──────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('5. DROPDOWN: Template Term');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);
  // Click the first multiselect button (Template Term)
  const ttCoords = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    const btn = iframe?.contentDocument?.querySelectorAll('button[data-testid="uicl-multi-select-input-button"]')[0];
    const r = btn?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, text: btn.textContent?.trim() } : null;
  });
  if (ttCoords) {
    await page.mouse.click(ttCoords.x, ttCoords.y);
    console.log(`  Clicked "${ttCoords.text}"`);
    await sleep(500);

    // Read items from DOM
    const items = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      const lists = iframe?.contentDocument?.querySelectorAll('.iui-list') ?? [];
      for (const l of lists) {
        if (getComputedStyle(l).display !== 'none' && l.children.length > 0)
          return Array.from(l.querySelectorAll('li')).map(li => li.textContent?.trim().slice(0, 40));
      }
      return [];
    });
    log('Template Term', items.length > 0, `${items.length} items: ${items.slice(0, 5).join(', ')}${items.length > 5 ? '...' : ''}`);

    // Select first item
    if (items.length > 0) {
      const itemCoords = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="proposal"]');
        const lists = iframe?.contentDocument?.querySelectorAll('.iui-list') ?? [];
        for (const l of lists) {
          if (getComputedStyle(l).display !== 'none' && l.children.length > 0) {
            const li = l.querySelector('li');
            const r = li?.getBoundingClientRect();
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, text: li.textContent?.trim() } : null;
          }
        }
        return null;
      });
      if (itemCoords) {
        await page.mouse.click(itemCoords.x, itemCoords.y);
        console.log(`  Selected: "${itemCoords.text}"`);
        await sleep(500);
        // Verify button text changed
        const newText = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[src*="proposal"]');
          return iframe?.contentDocument?.querySelectorAll('button[data-testid="uicl-multi-select-input-button"]')[0]?.textContent?.trim();
        });
        log('Template Term', newText !== 'Select', `Button now shows: "${newText?.slice(0, 30)}"`);
      }
    }
    // Click away to close dropdown
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      iframe?.contentDocument?.querySelector('.iui-form-page')?.click();
    });
    await sleep(300);
  }

  // ── 6. LENGTH dropdown → select non-Ongoing → verify End Date appears ──
  console.log('\n' + '═'.repeat(70));
  console.log('6. LENGTH: Change from Ongoing → fixed, check End Date');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);

  // Get the Length button specifically — it's the one containing "Ongoing"
  const lengthCoords = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="proposal"]');
    const btns = iframe?.contentDocument?.querySelectorAll('button[data-testid="uicl-multi-select-input-button"]') ?? [];
    for (const btn of btns) {
      if (/ongoing/i.test(btn.textContent?.trim())) {
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: btn.textContent?.trim() };
      }
    }
    return null;
  });

  if (lengthCoords) {
    await page.mouse.click(lengthCoords.x, lengthCoords.y);
    console.log(`  Clicked "${lengthCoords.text}"`);
    await sleep(500);

    // Read dropdown items — find the one that says something non-Ongoing-like
    const lengthItems = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      // The dropdown should be directly below the Length button
      // Find the visible dropdown list
      const lists = iframe?.contentDocument?.querySelectorAll('.iui-list') ?? [];
      for (const l of lists) {
        const style = getComputedStyle(l);
        if (style.display === 'none' || l.children.length === 0) continue;
        const lis = Array.from(l.querySelectorAll('li'));
        return lis.map(li => ({
          text: li.textContent?.trim(),
          rect: li.getBoundingClientRect().toJSON(),
        }));
      }
      return [];
    });
    console.log(`  Dropdown items: ${lengthItems.length}`);
    for (const it of lengthItems) console.log(`    "${it.text}"`);

    // These are likely month numbers. Pick "3" to set a 3-month term.
    // But first, verify iframe still alive after selection
    if (lengthItems.length > 0) {
      // Pick item "3" (or the 4th item)
      const target = lengthItems.find(i => i.text === '3') || lengthItems[3];
      if (target) {
        console.log(`\n  Selecting "${target.text}"...`);
        await page.mouse.click(target.rect.x + target.rect.width / 2, target.rect.y + target.rect.height / 2);
        await sleep(2000); // Wait for potential iframe reload

        // Check if iframe survived
        const alive = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[src*="proposal"]');
          const doc = iframe?.contentDocument;
          return {
            iframeExists: !!iframe,
            docReady: doc?.readyState,
            formExists: !!doc?.querySelector('form'),
            buttonCount: doc?.querySelectorAll('button').length ?? 0,
            url: doc?.URL?.slice(0, 80),
          };
        });
        console.log(`  After selecting "${target.text}":`);
        console.log(`    iframe exists: ${alive.iframeExists}`);
        console.log(`    doc ready: ${alive.docReady}`);
        console.log(`    form exists: ${alive.formExists}`);
        console.log(`    buttons: ${alive.buttonCount}`);
        console.log(`    URL: ${alive.url}`);

        if (alive.formExists) {
          // Check if End Date section appeared
          const sections = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="proposal"]');
            const doc = iframe?.contentDocument;
            return Array.from(doc?.querySelectorAll('.form-section-header, sub-header') ?? [])
              .map(h => h.textContent?.trim());
          });
          console.log(`  Form sections: ${sections.join(', ')}`);
          log('Length', sections.length > 0, `Form sections after change: ${sections.join(', ')}`);

          // Check for End Date related elements
          const endDate = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="proposal"]');
            const doc = iframe?.contentDocument;
            const labels = Array.from(doc?.querySelectorAll('label, .field-label, [class*="label"]') ?? []);
            return labels.filter(l => /end|date/i.test(l.textContent?.trim() || '')).map(l => l.textContent?.trim());
          });
          if (endDate.length > 0) {
            log('Length', true, `End Date labels found: ${endDate.join(', ')}`);
          }
        } else {
          // iframe reloaded — wait more and retry
          console.log('  Waiting for iframe to re-render...');
          await sleep(3000);
          const retry = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="proposal"]');
            return { exists: !!iframe, form: !!iframe?.contentDocument?.querySelector('form'), url: iframe?.src?.slice(0, 80) };
          });
          console.log(`  Retry: ${JSON.stringify(retry)}`);
          log('Length', retry.form, `After wait: form=${retry.form}`);
        }
      }
    }
  } else {
    log('Length', false, 'Ongoing button not found');
  }

  // ── 7. SUBMIT BUTTON ──────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('7. SUBMIT BUTTON');
  console.log('═'.repeat(70));
  await ensureDialog(page, cdp);
  ax = await getAx(cdp);
  const submit = ax.find(n => n.role?.value === 'button' && /send proposal/i.test(n.name?.value || ''));
  if (submit) {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: submit.backendDOMNodeId });
    const [x1, y1, , , x3, , , y4] = model.content;
    log('Submit', true, `"${submit.name?.value}" at (${((x1+x3)/2).toFixed(0)},${((y1+y4)/2).toFixed(0)}) — NOT clicking`);
  } else {
    log('Submit', false, 'Not found');
  }

  // ── SUMMARY ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  for (const r of R) console.log(`  ${r.ok ? '✓' : '✗'} [${r.t}] ${r.m}`);
  console.log(`\n  ${R.filter(r => r.ok).length} pass, ${R.filter(r => !r.ok).length} fail`);

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
