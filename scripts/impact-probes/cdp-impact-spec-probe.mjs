#!/usr/bin/env node
/**
 * Targeted probe for impact plugin spec §8 gaps:
 *
 * 1. Login detection elements (logged-in state indicators)
 * 2. Search input: selector + trigger mechanism
 * 3. Card: partner ID extraction + "already sent" indicator
 * 4. Hover + open dialog → enumerate ALL iframe form fields
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const IGNORE_FRAMES = /freshchat|wchat/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = (await browser.pages()).find(p => /impact\.com/.test(p.url()));
  if (!page) { console.error('No impact.com page'); process.exit(1); }
  const cdp = await page.createCDPSession();

  // ══════════════════════════════════════════════════════════════════
  // PROBE 1: Login state indicators
  // ══════════════════════════════════════════════════════════════════
  console.log('═'.repeat(70));
  console.log('PROBE 1: Login state detection');
  console.log('═'.repeat(70));

  const loginInfo = await page.evaluate(() => {
    const url = location.href;
    const title = document.title;

    // Look for user/account related elements
    const accountIndicators = [];
    const selectors = [
      '[data-testid*="account"]', '[data-testid*="user"]', '[data-testid*="profile"]',
      '[data-testid*="avatar"]', '[data-testid*="menu"]', '[data-testid*="nav"]',
      '[class*="account"]', '[class*="user-info"]', '[class*="avatar"]',
      '[class*="profile"]', '[class*="userName"]', '[class*="userProfile"]',
      '#accountMenu', '#userMenu', '.user-menu', '.account-menu',
      '[aria-label*="account"]', '[aria-label*="user"]', '[aria-label*="profile"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        accountIndicators.push({
          selector: sel,
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().slice(0, 60),
          classes: el.className?.toString().slice(0, 80),
          testId: el.getAttribute('data-testid'),
          visible: el.offsetParent !== null || getComputedStyle(el).display !== 'none',
        });
      }
    }

    // Check for nav/header that only appears when logged in
    const headerInfo = {};
    const header = document.querySelector('header, nav, [role="navigation"], [class*="header"], [class*="nav-bar"]');
    if (header) {
      headerInfo.tag = header.tagName.toLowerCase();
      headerInfo.classes = header.className?.toString().slice(0, 100);
      headerInfo.childCount = header.children.length;
    }

    // Look for the user's name/email display
    const userDisplays = [];
    for (const el of document.querySelectorAll('*')) {
      const cls = el.className?.toString() || '';
      if (/user.*name|account.*name|display.*name/i.test(cls) && el.textContent?.trim().length < 60) {
        userDisplays.push({ classes: cls.slice(0, 80), text: el.textContent?.trim() });
      }
    }

    return { url, title, accountIndicators: accountIndicators.slice(0, 20), headerInfo, userDisplays: userDisplays.slice(0, 5) };
  });

  console.log(`  URL: ${loginInfo.url}`);
  console.log(`  Title: "${loginInfo.title}"`);
  console.log(`\n  Account indicators: ${loginInfo.accountIndicators.length}`);
  for (const a of loginInfo.accountIndicators) {
    console.log(`    [${a.selector}] <${a.tag}> visible=${a.visible} testId="${a.testId}" text="${a.text}"`);
    console.log(`      class="${a.classes}"`);
  }
  console.log(`\n  Header/Nav: ${JSON.stringify(loginInfo.headerInfo)}`);
  console.log(`\n  User displays: ${JSON.stringify(loginInfo.userDisplays)}`);

  // Also check AX tree for logged-in indicators
  const ax = await cdp.send('Accessibility.getFullAXTree');
  const navNodes = ax.nodes.filter(n =>
    !n.ignored && /account|notification|sign out|log out|profile/i.test(n.name?.value || '')
  );
  console.log(`\n  AX nodes with account/notification/signout:`);
  for (const n of navNodes) {
    console.log(`    [${n.role?.value}] "${n.name?.value}" bid=${n.backendDOMNodeId}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PROBE 2: Search input
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PROBE 2: Search input');
  console.log('═'.repeat(70));

  const searchInfo = await page.evaluate(() => {
    // Find search-related inputs
    const inputs = [];
    for (const el of document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), [role="searchbox"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 50) continue; // skip tiny/hidden inputs
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        testId: el.getAttribute('data-testid'),
        ariaLabel: el.getAttribute('aria-label'),
        classes: el.className?.toString().slice(0, 80),
        id: el.id,
        value: el.value,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        parentClasses: el.parentElement?.className?.toString().slice(0, 60),
      });
    }

    // Also check for search buttons
    const searchBtns = [];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const text = el.textContent?.trim().toLowerCase();
      const label = el.getAttribute('aria-label')?.toLowerCase() || '';
      if (/search/i.test(text) || /search/i.test(label) || /search/i.test(el.className?.toString() || '')) {
        searchBtns.push({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().slice(0, 40),
          testId: el.getAttribute('data-testid'),
          classes: el.className?.toString().slice(0, 80),
        });
      }
    }

    // Check AX tree's searchbox
    return { inputs, searchBtns };
  });

  console.log(`  Text inputs: ${searchInfo.inputs.length}`);
  for (const inp of searchInfo.inputs) {
    console.log(`    <${inp.tag}> type="${inp.type}" name="${inp.name}" placeholder="${inp.placeholder}"`);
    console.log(`      testId="${inp.testId}" aria-label="${inp.ariaLabel}" id="${inp.id}"`);
    console.log(`      class="${inp.classes}"`);
    console.log(`      rect: ${JSON.stringify(inp.rect)} value="${inp.value}"`);
  }
  console.log(`\n  Search buttons: ${searchInfo.searchBtns.length}`);
  for (const b of searchInfo.searchBtns) {
    console.log(`    <${b.tag}> "${b.text}" testId="${b.testId}" class="${b.classes}"`);
  }

  // AX searchbox
  const searchAx = ax.nodes.filter(n =>
    !n.ignored && (n.role?.value === 'searchbox' || /search/i.test(n.name?.value || ''))
  );
  console.log(`\n  AX search nodes:`);
  for (const n of searchAx) {
    console.log(`    [${n.role?.value}] "${n.name?.value}" bid=${n.backendDOMNodeId}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PROBE 3: Card details — partner ID + already-sent indicator
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PROBE 3: Card details (partner ID, already-sent indicator)');
  console.log('═'.repeat(70));

  const cardDetails = await page.evaluate(() => {
    const cards = document.querySelectorAll('.discovery-card');
    const results = [];
    for (let i = 0; i < Math.min(cards.length, 5); i++) {
      const card = cards[i];
      const name = card.querySelector('.name .text-ellipsis')?.textContent?.trim();

      // Try to find partner ID from various sources
      const record = card.getAttribute('record'); // Vue binding?
      const dataAttrs = {};
      for (const attr of card.attributes) {
        if (attr.name.startsWith('data-') || attr.name === 'id') {
          dataAttrs[attr.name] = attr.value.slice(0, 80);
        }
      }

      // Check for links that might contain partner ID
      const links = [];
      for (const a of card.querySelectorAll('a')) {
        links.push({ href: a.href?.slice(0, 100), text: a.textContent?.trim().slice(0, 40) });
      }

      // Check image src for account ID
      const img = card.querySelector('img');
      const imgSrc = img?.src || '';
      const idFromImg = imgSrc.match(/\/(\d+)$/)?.[1];

      // Check for "already sent" or status indicators
      const statusEls = [];
      for (const el of card.querySelectorAll('[class*="status"], [class*="badge"], [class*="sent"], [class*="applied"], [class*="relationship"], [class*="pending"]')) {
        statusEls.push({
          classes: el.className?.toString().slice(0, 80),
          text: el.textContent?.trim().slice(0, 40),
          display: getComputedStyle(el).display,
        });
      }

      // Check for different button text (not "Send Proposal")
      const btns = [];
      for (const btn of card.querySelectorAll('button')) {
        btns.push({
          text: btn.textContent?.trim().slice(0, 40),
          display: getComputedStyle(btn).display,
          classes: btn.className?.toString().slice(0, 60),
          testId: btn.getAttribute('data-testid'),
        });
      }

      // Explore the Vue component data (if accessible)
      let vueData = null;
      try {
        const vm = card.__vue__ || card._vnode;
        if (vm) {
          const props = vm.$props || vm.props || {};
          vueData = JSON.stringify(props).slice(0, 200);
        }
      } catch {}

      // Check the record attribute (stringified object?)
      let recordParsed = null;
      if (card.getAttribute('record') === '[object Object]') {
        // It's a Vue bound prop, try __vue__
        try {
          const vm = card.__vue__;
          if (vm && vm.record) {
            const r = vm.record;
            recordParsed = {
              id: r.id || r.partnerId || r.accountId,
              name: r.name || r.partnerName,
              status: r.status || r.relationshipStatus,
              hasProposal: r.hasProposal || r.proposalSent,
              keys: Object.keys(r).slice(0, 30),
            };
          }
        } catch {}
      }

      results.push({
        index: i,
        name,
        dataAttrs,
        links,
        idFromImg,
        statusEls,
        btns,
        vueData,
        recordParsed,
        selected: card.getAttribute('selected'),
      });
    }
    return results;
  });

  for (const card of cardDetails) {
    console.log(`\n  Card[${card.index}]: "${card.name}"`);
    console.log(`    data attrs: ${JSON.stringify(card.dataAttrs)}`);
    console.log(`    idFromImg: ${card.idFromImg}`);
    console.log(`    links: ${JSON.stringify(card.links)}`);
    console.log(`    buttons:`);
    for (const b of card.btns) console.log(`      "${b.text}" display=${b.display} testId="${b.testId}"`);
    console.log(`    status elements: ${JSON.stringify(card.statusEls)}`);
    if (card.recordParsed) {
      console.log(`    Vue record: ${JSON.stringify(card.recordParsed)}`);
    } else {
      console.log(`    Vue record: not accessible`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PROBE 4: Hover + open dialog → enumerate iframe form fields
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PROBE 4: Iframe form field enumeration');
  console.log('═'.repeat(70));

  // Check if dialog already open
  let dialogOpen = await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'));

  if (!dialogOpen) {
    console.log('  Opening dialog via hover + click...');
    const cardRect = await page.evaluate(() => {
      const card = document.querySelectorAll('.discovery-card')[0];
      const r = card?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });

    if (cardRect) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardRect.x, y: cardRect.y });
      await sleep(500);

      // Find and click Send Proposal via AX
      const ax2 = await cdp.send('Accessibility.getFullAXTree');
      const btn = ax2.nodes.find(n => !n.ignored && n.role?.value === 'button' && /send proposal/i.test(n.name?.value || ''));
      if (btn) {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendDOMNodeId });
        const [x1, y1, , , x3, , , y4] = model.content;
        const cx = (x1 + x3) / 2, cy = (y1 + y4) / 2;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
        await sleep(50);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        console.log('  Click dispatched, waiting for iframe...');

        for (let i = 0; i < 20; i++) {
          await sleep(500);
          dialogOpen = await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'));
          if (dialogOpen) { console.log(`  Dialog opened after ${(i + 1) * 500}ms`); break; }
        }
      }
    }
  } else {
    console.log('  Dialog already open');
  }

  if (dialogOpen) {
    // Wait for form to fully load
    await sleep(2000);

    // Get iframe URL
    const iframeUrl = await page.evaluate(() =>
      document.querySelector('iframe[src*="proposal"]')?.src
    );
    console.log(`  iframe URL: ${iframeUrl}`);

    // Enumerate ALL form elements in iframe
    const formFields = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      const doc = iframe?.contentDocument;
      if (!doc) return { error: 'cannot access iframe contentDocument' };

      const fields = [];

      // All form controls
      for (const el of doc.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [role="combobox"], [role="listbox"]')) {
        const rect = el.getBoundingClientRect();
        const label = doc.querySelector(`label[for="${el.id}"]`)?.textContent?.trim();

        // Walk up to find label-like sibling or parent text
        let nearLabel = label;
        if (!nearLabel) {
          let parent = el.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const lbl = parent.querySelector('label, .iui-label, [class*="label"]');
            if (lbl && lbl.textContent?.trim()) {
              nearLabel = lbl.textContent.trim();
              break;
            }
            parent = parent.parentElement;
          }
        }

        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || el.getAttribute('role'),
          name: el.getAttribute('name'),
          id: el.id,
          testId: el.getAttribute('data-testid'),
          placeholder: el.getAttribute('placeholder'),
          value: el.value?.slice(0, 60),
          label: nearLabel?.slice(0, 60),
          required: el.required || el.getAttribute('aria-required') === 'true',
          disabled: el.disabled,
          classes: el.className?.toString().slice(0, 80),
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }

      // Also find custom dropdowns (impact uses button-based dropdowns)
      const dropdowns = [];
      for (const btn of doc.querySelectorAll('button[data-testid="uicl-multi-select-input-button"]')) {
        let nearLabel = null;
        let parent = btn.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const lbl = parent.querySelector('label, .iui-label, [class*="label"]');
          if (lbl && lbl.textContent?.trim()) {
            nearLabel = lbl.textContent.trim();
            break;
          }
          parent = parent.parentElement;
        }
        dropdowns.push({
          text: btn.textContent?.trim().slice(0, 40),
          testId: btn.getAttribute('data-testid'),
          label: nearLabel?.slice(0, 60),
          classes: btn.className?.toString().slice(0, 80),
        });
      }

      // Form sections/headers
      const sections = [];
      for (const el of doc.querySelectorAll('h1, h2, h3, h4, h5, .form-section-header, [class*="section-header"], [class*="sub-header"]')) {
        sections.push({ tag: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 60), classes: el.className?.toString().slice(0, 60) });
      }

      // Also get the full form structure as text outline
      const formEl = doc.querySelector('form');
      const formLabels = [];
      if (formEl) {
        for (const lbl of formEl.querySelectorAll('label, .iui-label')) {
          formLabels.push(lbl.textContent?.trim());
        }
      }

      return { fields, dropdowns, sections, formLabels, formExists: !!formEl };
    });

    if (formFields.error) {
      console.log(`  ERROR: ${formFields.error}`);
    } else {
      console.log(`\n  Form exists: ${formFields.formExists}`);
      console.log(`\n  Sections/Headers:`);
      for (const s of formFields.sections) console.log(`    <${s.tag}> "${s.text}" class="${s.classes}"`);

      console.log(`\n  Form labels: ${formFields.formLabels.join(' | ')}`);

      console.log(`\n  Form controls: ${formFields.fields.length}`);
      for (const f of formFields.fields) {
        console.log(`    <${f.tag}> type="${f.type}" name="${f.name}" id="${f.id}"`);
        console.log(`      testId="${f.testId}" placeholder="${f.placeholder}"`);
        console.log(`      label="${f.label}" required=${f.required} disabled=${f.disabled}`);
        console.log(`      value="${f.value}" size=${f.rect.w}×${f.rect.h}`);
        console.log(`      class="${f.classes}"`);
      }

      console.log(`\n  Custom dropdowns: ${formFields.dropdowns.length}`);
      for (const d of formFields.dropdowns) {
        console.log(`    "${d.text}" label="${d.label}" testId="${d.testId}"`);
      }
    }

    // Also get iframe AX tree for complete picture
    const { frameTree } = await cdp.send('Page.getFrameTree');
    let iframeId = null;
    (function f(ft) {
      for (const c of ft.childFrames ?? []) {
        if (!IGNORE_FRAMES.test(c.frame.url) && c.frame.url.includes('impact.com')) { iframeId = c.frame.id; return; }
        f(c);
      }
    })(frameTree);

    if (iframeId) {
      const iframeAx = await cdp.send('Accessibility.getFullAXTree', { frameId: iframeId });
      const interactiveNodes = iframeAx.nodes.filter(n => {
        if (n.ignored) return false;
        return ['button', 'textbox', 'combobox', 'radio', 'checkbox', 'spinbutton', 'switch', 'link', 'searchbox'].includes(n.role?.value);
      });
      console.log(`\n  iframe AX interactive nodes: ${interactiveNodes.length}`);
      for (const n of interactiveNodes) {
        const props = (n.properties ?? [])
          .filter(p => ['checked', 'required', 'disabled', 'expanded', 'selected'].includes(p.name))
          .map(p => `${p.name}=${p.value?.value}`)
          .join(', ');
        console.log(`    [${n.role?.value}] "${(n.name?.value || '').slice(0, 50)}" bid=${n.backendDOMNodeId}${props ? ` (${props})` : ''}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PROBE 5: Confirmation popup type (look for dialog patterns in page)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PROBE 5: Confirmation popup patterns');
  console.log('═'.repeat(70));

  const confirmInfo = await page.evaluate(() => {
    // Check for modal/dialog containers in main page
    const modals = [];
    for (const sel of ['[role="dialog"]', '[role="alertdialog"]', '.modal', '[class*="modal"]', '[class*="dialog"]', '[class*="confirm"]', '[class*="overlay"]']) {
      for (const el of document.querySelectorAll(sel)) {
        modals.push({
          selector: sel,
          tag: el.tagName.toLowerCase(),
          classes: el.className?.toString().slice(0, 80),
          display: getComputedStyle(el).display,
          text: el.textContent?.trim().slice(0, 100),
        });
      }
    }

    // Check if window.confirm is overridden
    const confirmOverridden = window.confirm !== Window.prototype.confirm;

    return { modals: modals.slice(0, 10), confirmOverridden };
  });

  console.log(`  window.confirm overridden: ${confirmInfo.confirmOverridden}`);
  console.log(`  Modal/dialog elements in DOM: ${confirmInfo.modals.length}`);
  for (const m of confirmInfo.modals) {
    console.log(`    [${m.selector}] <${m.tag}> display=${m.display} class="${m.classes}"`);
    if (m.text) console.log(`      text: "${m.text.slice(0, 80)}"`);
  }

  await cdp.detach();
  browser.disconnect();
  console.log('\n  Done.');
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
