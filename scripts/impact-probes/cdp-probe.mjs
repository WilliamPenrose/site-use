#!/usr/bin/env node
/**
 * Minimal CDP probe script — connects to a running Chrome instance (via site-use),
 * finds the impact.com page, and runs three CDP calls to answer:
 *
 * 1. iframe: same-origin or OOPIF?
 * 2. Does pierce=true penetrate iframes?
 * 3. Does DOMSnapshot contain "invisible" elements the AX tree misses?
 * 4. What is the devicePixelRatio?
 * 5. Is isClickable sufficient?
 *
 * Usage: node scripts/cdp-probe.mjs
 *
 * Requires: Chrome already running with site-use (reads ~/.site-use/chrome.json)
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// ── Config ──────────────────────────────────────────────────────────────

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  // 1. Connect to the running Chrome
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  console.log(`[probe] Connecting to: ${wsEndpoint}`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
  });

  // 2. Find the target page
  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) {
    console.error('[probe] No impact.com page found. Available pages:');
    for (const p of pages) console.error(`  - ${p.url()}`);
    browser.disconnect();
    process.exit(1);
  }
  console.log(`[probe] Found page: ${page.url()}`);

  // 3. Get a raw CDP session
  const cdp = await page.createCDPSession();

  try {
    // ── Call 1: DOM.getDocument (pierce=true) ─────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('CALL 1: DOM.getDocument(depth=-1, pierce=true)');
    console.log('='.repeat(70));

    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });

    // Recursively collect all iframes and their frameIds
    const iframes = [];
    function walkFrames(node, depth = 0) {
      if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
        iframes.push({
          depth,
          nodeName: node.nodeName,
          frameId: node.frameId ?? '(none)',
          src: getAttr(node, 'src') ?? '(no src)',
          hasContentDocument: !!node.contentDocument,
          contentDocURL: node.contentDocument?.documentURL ?? '(N/A)',
          backendNodeId: node.backendNodeId,
        });
        if (node.contentDocument) {
          walkFrames(node.contentDocument, depth + 1);
        }
      }
      for (const child of node.children ?? []) {
        walkFrames(child, depth);
      }
      for (const sr of node.shadowRoots ?? []) {
        walkFrames(sr, depth);
      }
    }
    function getAttr(node, name) {
      const attrs = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === name) return attrs[i + 1];
      }
      return null;
    }

    walkFrames(doc.root);
    console.log(`\nTotal IFRAME/FRAME elements found: ${iframes.length}`);
    for (const f of iframes) {
      console.log(`\n  [${'  '.repeat(f.depth)}${f.nodeName}]`);
      console.log(`    src: ${f.src}`);
      console.log(`    frameId: ${f.frameId}`);
      console.log(`    pierce penetrated: ${f.hasContentDocument}`);
      console.log(`    contentDocument URL: ${f.contentDocURL}`);
      console.log(`    backendNodeId: ${f.backendNodeId}`);

      const mainOrigin = new URL(doc.root.documentURL).origin;
      if (f.contentDocURL && f.contentDocURL !== '(N/A)') {
        try {
          const frameOrigin = new URL(f.contentDocURL).origin;
          const same = mainOrigin === frameOrigin;
          console.log(`    origin: main=${mainOrigin} frame=${frameOrigin} → ${same ? 'SAME-ORIGIN' : 'CROSS-ORIGIN (likely OOPIF)'}`);
        } catch {
          console.log(`    origin: cannot parse URL`);
        }
      }
    }

    // Count total nodes
    let totalNodes = 0;
    function countNodes(node) {
      totalNodes++;
      for (const child of node.children ?? []) countNodes(child);
      for (const sr of node.shadowRoots ?? []) countNodes(sr);
      if (node.contentDocument) countNodes(node.contentDocument);
    }
    countNodes(doc.root);
    console.log(`\nTotal DOM nodes (with pierce): ${totalNodes}`);

    // ── Call 2: DOMSnapshot.captureSnapshot ───────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('CALL 2: DOMSnapshot.captureSnapshot');
    console.log('='.repeat(70));

    const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [
        'display', 'visibility', 'opacity', 'overflow',
        'position', 'z-index', 'pointer-events',
        'font-size', 'color', 'background-color',
      ],
    });

    console.log(`\nNumber of documents: ${snapshot.documents.length}`);
    for (let i = 0; i < snapshot.documents.length; i++) {
      const sdoc = snapshot.documents[i];
      const urlIdx = sdoc.documentURL;
      const url = snapshot.strings[urlIdx];
      const nodeCount = sdoc.nodes.nodeType.length;

      const hasLayout = sdoc.layout && sdoc.layout.nodeIndex.length > 0;
      const layoutCount = hasLayout ? sdoc.layout.nodeIndex.length : 0;

      console.log(`\n  Document[${i}]: ${url}`);
      console.log(`    nodes: ${nodeCount}`);
      console.log(`    nodes with layout (visible): ${layoutCount}`);
      console.log(`    nodes without layout (hidden): ${nodeCount - layoutCount}`);

      const textCount = sdoc.textValue?.index?.length ?? 0;
      console.log(`    text nodes: ${textCount}`);
    }

    console.log(`\nShared strings table size: ${snapshot.strings.length}`);

    // ── Call 3: Accessibility.getFullAXTree ───────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('CALL 3: Accessibility.getFullAXTree');
    console.log('='.repeat(70));

    // Main frame AX tree
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const axNodes = ax.nodes;
    console.log(`\nMain frame AX nodes: ${axNodes.length}`);

    // Try to get AX trees from child frames too
    const allFrames = page.frames();
    console.log(`\nTotal frames (Puppeteer): ${allFrames.length}`);
    let totalAxNodes = axNodes.length;
    for (const frame of allFrames) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameCdp = await frame.createCDPSession();
        const frameAx = await frameCdp.send('Accessibility.getFullAXTree');
        console.log(`  Frame: ${frame.url().slice(0, 80)} → ${frameAx.nodes.length} AX nodes`);
        totalAxNodes += frameAx.nodes.length;
        await frameCdp.detach();
      } catch (err) {
        console.log(`  Frame: ${frame.url().slice(0, 80)} → ERROR: ${err.message}`);
      }
    }
    console.log(`\nTotal AX nodes (all frames): ${totalAxNodes}`);

    // Analyze main frame AX tree
    const roleCounts = {};
    let ignoredCount = 0;
    let hasBackendNodeId = 0;
    for (const n of axNodes) {
      const role = n.role?.value ?? '(none)';
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      if (n.ignored) ignoredCount++;
      if (n.backendDOMNodeId) hasBackendNodeId++;
    }

    console.log(`\n  Main frame — ignored: ${ignoredCount}`);
    console.log(`  Main frame — with backendDOMNodeId: ${hasBackendNodeId}`);

    const sorted = Object.entries(roleCounts).sort((a, b) => b[1] - a[1]);
    console.log('\n  Top 20 roles (main frame):');
    for (const [role, count] of sorted.slice(0, 20)) {
      console.log(`    ${role}: ${count}`);
    }

    // Check for frameId in AX nodes
    const framesInAx = new Set();
    for (const n of axNodes) {
      if (n.frameId) framesInAx.add(n.frameId);
    }
    console.log(`\n  Distinct frameIds in main AX tree: ${framesInAx.size}`);
    for (const fid of framesInAx) {
      console.log(`    - ${fid}`);
    }

    // ── DPR ──────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('BONUS: Device Pixel Ratio');
    console.log('='.repeat(70));

    const dpr = await page.evaluate(() => window.devicePixelRatio);
    console.log(`  DPR: ${dpr}`);

    // ── isClickable check ────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('BONUS: isClickable coverage check');
    console.log('='.repeat(70));

    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio',
      'combobox', 'menuitem', 'tab', 'switch', 'searchbox',
      'spinbutton', 'slider',
    ]);
    let interactiveCount = 0;
    let focusableCount = 0;
    for (const n of axNodes) {
      if (n.ignored) continue;
      const role = n.role?.value;
      if (interactiveRoles.has(role)) interactiveCount++;
      const props = n.properties ?? [];
      for (const p of props) {
        if (p.name === 'focusable' && p.value?.value === true) {
          focusableCount++;
          break;
        }
      }
    }
    console.log(`  Interactive role nodes: ${interactiveCount}`);
    console.log(`  Focusable nodes: ${focusableCount}`);

    // JS listener detection (browser-use style)
    const jsClickableCount = await page.evaluate(() => {
      let count = 0;
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.cursor === 'pointer') count++;
      }
      return count;
    });
    console.log(`  Elements with cursor:pointer (JS clickable proxy): ${jsClickableCount}`);

    // ── Summary ──────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY — Questions to answer');
    console.log('='.repeat(70));
    console.log(`
  Q1 (iframe same-origin vs OOPIF):
      Found ${iframes.length} iframe(s). See CALL 1 details above.
      Puppeteer sees ${allFrames.length} frames total.

  Q2 (pierce=true penetration):
      ${iframes.filter(f => f.hasContentDocument).length}/${iframes.length} iframes have contentDocument (pierced by DOM.getDocument).
      DOMSnapshot captured ${snapshot.documents.length} documents.

  Q3 (DOMSnapshot vs AX coverage):
      DOM nodes (pierced): ${totalNodes}
      DOMSnapshot documents: ${snapshot.documents.length}
      AX nodes (main frame): ${axNodes.length}
      AX nodes (all frames): ${totalAxNodes}
      → If DOMSnapshot docs > 1, it captures iframe content.
      → If AX all-frames >> main-frame, per-frame AX queries needed.

  Q4 (DPR):
      ${dpr}

  Q5 (isClickable):
      Interactive AX roles: ${interactiveCount}
      Focusable AX nodes: ${focusableCount}
      cursor:pointer elements: ${jsClickableCount}
      → Large gap (cursor:pointer >> interactive roles) means
        JS listeners add significant clickability not in AX tree.
`);

  } finally {
    cdp.detach();
    browser.disconnect();
  }
}

main().catch(err => {
  console.error('[probe] Fatal:', err);
  process.exit(1);
});
