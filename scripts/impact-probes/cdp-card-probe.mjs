#!/usr/bin/env node
/**
 * Probe partner cards on impact.com — understand hover-reveal buttons.
 *
 * Questions:
 * 1. What does a card look like in DOM? (structure, classes, data-testid)
 * 2. What does AX tree see? (roles, names)
 * 3. Is the "Send Proposal" button in DOM but hidden (display:none / visibility:hidden / opacity:0)?
 *    Or is it injected on hover via JS?
 * 4. Does DOMSnapshot capture it with layout bounds?
 * 5. What CSS mechanism hides/shows it?
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) { console.error('No impact.com page'); process.exit(1); }

  const cdp = await page.createCDPSession();

  // ── 1. DOM: Find card structure ────────────────────────────────────
  console.log('='.repeat(70));
  console.log('PART 1: DOM structure of partner cards (via evaluate)');
  console.log('='.repeat(70));

  const cardAnalysis = await page.evaluate(() => {
    // Look for card-like containers
    const results = [];

    // Try common card patterns
    const selectors = [
      '[data-testid*="card"]',
      '[data-testid*="partner"]',
      '[class*="card"]',
      '[class*="partner"]',
      '[class*="Card"]',
      '[class*="Partner"]',
      '.marketplace-card',
      '.partner-card',
      '[class*="result"]',
      '[class*="Result"]',
      '[class*="item"]',
      '[class*="listing"]',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        results.push({
          selector: sel,
          count: els.length,
          firstTag: els[0].tagName.toLowerCase(),
          firstClasses: els[0].className?.toString().slice(0, 120),
          firstTestId: els[0].getAttribute('data-testid'),
        });
      }
    }

    // Look for "Send Proposal" text anywhere in the page
    const allElements = document.querySelectorAll('*');
    const proposalElements = [];
    for (const el of allElements) {
      const text = el.textContent?.trim();
      if (text && /send\s*proposal/i.test(text) && el.children.length === 0) {
        const style = getComputedStyle(el);
        const parent = el.closest('[class*="card"], [class*="partner"], [class*="item"], [class*="result"]');
        proposalElements.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 60),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          parentTag: el.parentElement?.tagName.toLowerCase(),
          parentClasses: el.parentElement?.className?.toString().slice(0, 80),
          parentTestId: el.parentElement?.getAttribute('data-testid'),
          grandparentClasses: el.parentElement?.parentElement?.className?.toString().slice(0, 80),
          cardAncestor: parent ? {
            tag: parent.tagName.toLowerCase(),
            classes: parent.className?.toString().slice(0, 80),
            testId: parent.getAttribute('data-testid'),
          } : null,
          rect: el.getBoundingClientRect().toJSON(),
        });
      }
    }

    // Also find buttons/links with proposal-related attributes
    const proposalButtons = [];
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const text = el.textContent?.trim();
      const testId = el.getAttribute('data-testid');
      const ariaLabel = el.getAttribute('aria-label');
      if ((text && /proposal/i.test(text)) || (testId && /proposal/i.test(testId)) || (ariaLabel && /proposal/i.test(ariaLabel))) {
        const style = getComputedStyle(el);
        proposalButtons.push({
          tag: el.tagName.toLowerCase(),
          text: text?.slice(0, 60),
          testId,
          ariaLabel,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          cursor: style.cursor,
          rect: el.getBoundingClientRect().toJSON(),
          classes: el.className?.toString().slice(0, 100),
        });
      }
    }

    return { cardSelectors: results, proposalTextElements: proposalElements, proposalButtons };
  });

  console.log('\n  Card-like selectors found:');
  for (const r of cardAnalysis.cardSelectors) {
    console.log(`    ${r.selector}: ${r.count} elements`);
    console.log(`      first: <${r.firstTag} class="${r.firstClasses}" data-testid="${r.firstTestId}">`);
  }

  console.log(`\n  "Send Proposal" text elements: ${cardAnalysis.proposalTextElements.length}`);
  for (const el of cardAnalysis.proposalTextElements.slice(0, 5)) {
    console.log(`    <${el.tag}> "${el.text}"`);
    console.log(`      display=${el.display} visibility=${el.visibility} opacity=${el.opacity}`);
    console.log(`      rect: x=${el.rect.x.toFixed(0)} y=${el.rect.y.toFixed(0)} w=${el.rect.width.toFixed(0)} h=${el.rect.height.toFixed(0)}`);
    console.log(`      parent: <${el.parentTag} class="${el.parentClasses}" data-testid="${el.parentTestId}">`);
    if (el.cardAncestor) {
      console.log(`      card ancestor: <${el.cardAncestor.tag} class="${el.cardAncestor.classes}" data-testid="${el.cardAncestor.testId}">`);
    }
  }

  console.log(`\n  Proposal buttons/links: ${cardAnalysis.proposalButtons.length}`);
  for (const b of cardAnalysis.proposalButtons.slice(0, 5)) {
    console.log(`    <${b.tag}> "${b.text}"`);
    console.log(`      testId="${b.testId}" aria-label="${b.ariaLabel}"`);
    console.log(`      display=${b.display} visibility=${b.visibility} opacity=${b.opacity} cursor=${b.cursor}`);
    console.log(`      rect: x=${b.rect.x.toFixed(0)} y=${b.rect.y.toFixed(0)} w=${b.rect.width.toFixed(0)} h=${b.rect.height.toFixed(0)}`);
    console.log(`      class="${b.classes}"`);
  }

  // ── 2. Deep dive: first card's full subtree ────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 2: First card full DOM subtree');
  console.log('='.repeat(70));

  const firstCardHtml = await page.evaluate(() => {
    // Find a card that likely contains partner info
    // Try to find the repeating list item pattern
    const patterns = [
      '[data-testid*="card"]',
      '[class*="partner-card"]',
      '[class*="PartnerCard"]',
      '[class*="result-card"]',
      '[class*="listing-item"]',
    ];

    for (const sel of patterns) {
      const el = document.querySelector(sel);
      if (el) return { selector: sel, html: el.outerHTML.slice(0, 3000) };
    }

    // Fallback: find the parent of "Send Proposal" text and go up
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.children.length === 0 && /send\s*proposal/i.test(el.textContent?.trim() || '')) {
        // Go up until we find something card-sized
        let parent = el;
        for (let i = 0; i < 10; i++) {
          parent = parent.parentElement;
          if (!parent) break;
          const rect = parent.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 100) {
            return {
              selector: `(ancestor of "Send Proposal", ${i+1} levels up)`,
              html: parent.outerHTML.slice(0, 5000),
              tag: parent.tagName.toLowerCase(),
              classes: parent.className?.toString().slice(0, 100),
              rect: rect.toJSON(),
            };
          }
        }
      }
    }

    return null;
  });

  if (firstCardHtml) {
    console.log(`\n  Found via: ${firstCardHtml.selector}`);
    if (firstCardHtml.rect) {
      console.log(`  Size: ${firstCardHtml.rect.width.toFixed(0)}x${firstCardHtml.rect.height.toFixed(0)}`);
    }
    console.log(`\n  HTML (truncated):\n${firstCardHtml.html}`);
  } else {
    console.log('  No card found via heuristics.');
  }

  // ── 3. CSS hover mechanism ─────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 3: Hover mechanism analysis');
  console.log('='.repeat(70));

  const hoverInfo = await page.evaluate(() => {
    // Check all stylesheets for :hover rules related to proposal/card
    const hoverRules = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            const sel = rule.selectorText || '';
            if (sel.includes(':hover') && (
              /proposal|card|partner|action|overlay|btn|button/i.test(sel) ||
              /opacity|display|visibility|transform/i.test(rule.cssText || '')
            )) {
              hoverRules.push({
                selector: sel.slice(0, 120),
                cssText: rule.cssText?.slice(0, 200),
                sheet: sheet.href?.split('/').pop() || '(inline)',
              });
            }
          }
        } catch { /* cross-origin stylesheet */ }
      }
    } catch {}

    // Also check: is "Send Proposal" button always in DOM but CSS-hidden?
    // Or does it get added/removed by JS on mouseenter/mouseleave?
    const proposalBtns = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length === 0 && /^send proposal$/i.test(el.textContent?.trim() || '')) {
        proposalBtns.push({
          tag: el.tagName.toLowerCase(),
          inDOM: true,
          parentDisplay: getComputedStyle(el.parentElement).display,
          parentVisibility: getComputedStyle(el.parentElement).visibility,
          parentOpacity: getComputedStyle(el.parentElement).opacity,
          // Walk up to find the hiding ancestor
          hidingAncestor: (() => {
            let p = el;
            for (let i = 0; i < 15; i++) {
              p = p.parentElement;
              if (!p) return null;
              const s = getComputedStyle(p);
              if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) {
                return {
                  levels: i + 1,
                  tag: p.tagName.toLowerCase(),
                  classes: p.className?.toString().slice(0, 80),
                  display: s.display,
                  visibility: s.visibility,
                  opacity: s.opacity,
                };
              }
            }
            return { levels: 'none found', note: 'element is visible or hidden by other means' };
          })(),
        });
      }
    }

    return { hoverRules: hoverRules.slice(0, 20), proposalBtnsInDOM: proposalBtns };
  });

  console.log(`\n  Hover-related CSS rules: ${hoverInfo.hoverRules.length}`);
  for (const r of hoverInfo.hoverRules) {
    console.log(`    [${r.sheet}] ${r.selector}`);
    console.log(`      ${r.cssText}`);
  }

  console.log(`\n  "Send Proposal" buttons in DOM (without hover): ${hoverInfo.proposalBtnsInDOM.length}`);
  for (const b of hoverInfo.proposalBtnsInDOM) {
    console.log(`    <${b.tag}> inDOM=${b.inDOM}`);
    console.log(`      parent: display=${b.parentDisplay} visibility=${b.parentVisibility} opacity=${b.parentOpacity}`);
    if (b.hidingAncestor) {
      console.log(`      hiding ancestor: ${JSON.stringify(b.hidingAncestor)}`);
    }
  }

  // ── 4. AX tree view of cards ───────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 4: AX tree — what does it see for cards?');
  console.log('='.repeat(70));

  const ax = await cdp.send('Accessibility.getFullAXTree');
  // Find nodes with "proposal" or partner names in them
  const proposalAx = ax.nodes.filter(n =>
    !n.ignored && /proposal/i.test(n.name?.value || '')
  );
  console.log(`\n  AX nodes matching "proposal": ${proposalAx.length}`);
  for (const n of proposalAx) {
    console.log(`    [${n.role?.value}] "${n.name?.value}" backendNodeId=${n.backendDOMNodeId}`);
  }

  // Show all non-ignored, non-generic nodes to understand what AX sees
  const meaningfulAx = ax.nodes.filter(n => {
    if (n.ignored) return false;
    const role = n.role?.value;
    if (['generic', 'none', 'InlineTextBox', 'StaticText'].includes(role)) return false;
    return true;
  });
  console.log(`\n  Meaningful AX nodes (non-generic, non-text): ${meaningfulAx.length}`);
  for (const n of meaningfulAx.slice(0, 40)) {
    console.log(`    [${n.role?.value}] "${(n.name?.value || '').slice(0, 50)}" backendNodeId=${n.backendDOMNodeId}`);
  }

  // ── 5. DOMSnapshot — check if hidden buttons have layout ──────────
  console.log('\n' + '='.repeat(70));
  console.log('PART 5: DOMSnapshot — do hidden "Send Proposal" buttons have layout?');
  console.log('='.repeat(70));

  const snap = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['display', 'visibility', 'opacity', 'cursor', 'pointer-events'],
  });

  // Search strings table for "Send Proposal"
  const proposalStrIdx = snap.strings.findIndex(s => /send\s*proposal/i.test(s));
  if (proposalStrIdx >= 0) {
    console.log(`  Found "Send Proposal" in strings table at index ${proposalStrIdx}: "${snap.strings[proposalStrIdx]}"`);
  }

  // Find nodes whose textValue references proposal
  const sdoc = snap.documents[0];
  const textIndices = sdoc.textValue?.index ?? [];
  const textValues = sdoc.textValue?.value ?? [];
  for (let i = 0; i < textIndices.length; i++) {
    const strVal = snap.strings[textValues[i]];
    if (/send proposal/i.test(strVal)) {
      const nodeIdx = textIndices[i];
      const backendId = sdoc.nodes.backendNodeId[nodeIdx];
      // Check if this node has layout
      const layoutIdx = sdoc.layout.nodeIndex.indexOf(nodeIdx);
      console.log(`  Text node "${strVal}" at nodeIdx=${nodeIdx} backendNodeId=${backendId}`);
      console.log(`    has layout: ${layoutIdx >= 0}`);
      if (layoutIdx >= 0) {
        const b = sdoc.layout.bounds.slice(layoutIdx * 4, layoutIdx * 4 + 4);
        console.log(`    bounds: [${b.map(v => (v/2).toFixed(0)).join(', ')}] (÷DPR)`);
      }
    }
  }

  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
