#!/usr/bin/env node
/**
 * Verify the snapshot pipeline against a live impact.com page.
 *
 * Tests:
 * 1. fetchAXData — multi-frame traversal, iframe detection
 * 2. Full pipeline — mergeAXData + buildSnapshotOutput produce correct snapshot
 * 3. hover — CSS selector hover dispatches mouseMoved
 * 4. Comparison — pipeline output vs old single-frame approach
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// Import pipeline modules (built JS)
import { fetchAXData } from '../dist/primitives/snapshot/fetch.js';
import { hydrateAXData } from '../dist/primitives/snapshot/hydrate.js';
import { mergeAXData } from '../dist/primitives/snapshot/merge.js';
import { filterNodes } from '../dist/primitives/snapshot/filter.js';
import { buildSnapshotOutput } from '../dist/primitives/snapshot/output.js';

const CHROME_JSON = join(homedir(), '.site-use', 'chrome.json');
const TARGET_URL_PATTERN = /impact\.com/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  const { wsEndpoint } = JSON.parse(readFileSync(CHROME_JSON, 'utf8'));
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => TARGET_URL_PATTERN.test(p.url()));
  if (!page) { console.error('No impact.com page found'); process.exit(1); }

  console.log(`Page: ${page.url()}\n`);
  const cdp = await page.createCDPSession();

  // ── Test 1: fetchAXData — frame traversal ─────────────────────────
  console.log('TEST 1: fetchAXData — frame traversal');
  console.log('-'.repeat(50));

  const rawData = await fetchAXData(cdp);
  check('fetchAXData returns data', rawData.length > 0, `${rawData.length} frames`);

  const mainFrame = rawData.find(f => f.isMainFrame);
  check('main frame found', !!mainFrame, mainFrame?.frameUrl);
  check('main frame has AX nodes', mainFrame?.nodes.length > 0, `${mainFrame?.nodes.length} nodes`);

  const iframes = rawData.filter(f => !f.isMainFrame);
  console.log(`  iframes found: ${iframes.length}`);
  for (const f of iframes) {
    console.log(`    - ${f.frameId}: ${f.frameUrl} (${f.nodes.length} AX nodes)`);
  }

  // Check if any same-origin iframe exists (impact.com uses iframes for forms)
  const hasBusinessIframe = iframes.some(f =>
    !/(freshchat|wchat)/.test(f.frameUrl)
  );
  check('has business iframe (non-Freshchat)', hasBusinessIframe);

  // ── Test 2: Full pipeline — merge + output ────────────────────────
  console.log('\nTEST 2: Full pipeline — merge + output');
  console.log('-'.repeat(50));

  const hydrated = hydrateAXData(rawData);
  const { nodes, uidToBackendNodeId, axIdToUid } = mergeAXData(hydrated);
  const filtered = filterNodes(nodes);
  const snapshot = buildSnapshotOutput(filtered, axIdToUid);

  check('snapshot has nodes', snapshot.idToNode.size > 0, `${snapshot.idToNode.size} total`);
  check('uidToBackendNodeId populated', uidToBackendNodeId.size > 0, `${uidToBackendNodeId.size} entries`);

  // Count main frame vs iframe nodes
  let mainCount = 0, iframeCount = 0;
  for (const [, node] of snapshot.idToNode) {
    if (node.frameUrl) iframeCount++;
    else mainCount++;
  }
  check('main frame nodes present', mainCount > 0, `${mainCount} nodes`);
  check('iframe nodes have frameUrl set', iframeCount > 0 || !hasBusinessIframe,
    hasBusinessIframe ? `${iframeCount} nodes with frameUrl` : 'no business iframe on page');

  // Check uid sequential
  const uids = Array.from(snapshot.idToNode.keys()).map(Number);
  const maxUid = Math.max(...uids);
  check('uids are sequential from 1', uids.includes(1) && maxUid === snapshot.idToNode.size);

  // Spot-check: find some interactive elements
  const buttons = [];
  const links = [];
  const textboxes = [];
  for (const [, node] of snapshot.idToNode) {
    if (node.role === 'button') buttons.push(node);
    if (node.role === 'link') links.push(node);
    if (node.role === 'textbox') textboxes.push(node);
  }
  check('snapshot has buttons', buttons.length > 0, `${buttons.length} buttons`);
  check('snapshot has links', links.length > 0, `${links.length} links`);

  // If iframe exists, check iframe-specific nodes
  if (hasBusinessIframe) {
    const iframeButtons = buttons.filter(b => b.frameUrl);
    const iframeTextboxes = textboxes.filter(t => t.frameUrl);
    console.log(`  iframe buttons: ${iframeButtons.length}`);
    console.log(`  iframe textboxes: ${iframeTextboxes.length}`);
    if (iframeButtons.length > 0) {
      console.log(`    first iframe button: [${iframeButtons[0].role}] "${iframeButtons[0].name}" (frameUrl: ${iframeButtons[0].frameUrl})`);
    }
  }

  // ── Test 3: Compare with old single-frame approach ────────────────
  console.log('\nTEST 3: Compare pipeline vs old single-frame');
  console.log('-'.repeat(50));

  const oldAx = await cdp.send('Accessibility.getFullAXTree');
  const oldNodeCount = oldAx.nodes.filter(n => !n.ignored && n.role?.value !== 'none' && n.role?.value !== 'Ignored').length;
  const newNodeCount = snapshot.idToNode.size;

  console.log(`  old (no frameId): ${oldNodeCount} nodes`);
  console.log(`  new (pipeline):   ${newNodeCount} nodes`);
  console.log(`  delta:            +${newNodeCount - oldNodeCount} from iframes`);
  check('pipeline captures >= old approach', newNodeCount >= oldNodeCount);
  if (hasBusinessIframe) {
    check('pipeline captures MORE nodes (iframe content)', newNodeCount > oldNodeCount,
      `+${newNodeCount - oldNodeCount} iframe nodes`);
  }

  // ── Test 4: hover ─────────────────────────────────────────────────
  console.log('\nTEST 4: hover via CDP');
  console.log('-'.repeat(50));

  // Check if there are .discovery-card elements
  const cardExists = await page.evaluate(() => !!document.querySelector('.discovery-card'));
  if (cardExists) {
    // Get button state before hover
    const btnBefore = await page.evaluate(() => {
      const card = document.querySelector('.discovery-card');
      const btn = card?.querySelector('button[data-testid="uicl-button"]');
      return btn ? getComputedStyle(btn).display : null;
    });
    console.log(`  button display before hover: ${btnBefore}`);

    // Hover via CDP
    const cardRect = await page.evaluate(() => {
      const card = document.querySelector('.discovery-card');
      const r = card.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = cardRect.x + cardRect.w / 2;
    const cy = cardRect.y + cardRect.h / 2;

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await sleep(500);

    const btnAfter = await page.evaluate(() => {
      const card = document.querySelector('.discovery-card');
      const btn = card?.querySelector('button[data-testid="uicl-button"]');
      return btn ? getComputedStyle(btn).display : null;
    });
    console.log(`  button display after hover: ${btnAfter}`);
    check('hover reveals hidden button', btnBefore === 'none' && btnAfter !== 'none');

    // Take snapshot after hover and check "Send Proposal" is visible
    const rawAfterHover = await fetchAXData(cdp);
    const hydratedAfter = hydrateAXData(rawAfterHover);
    const mergedAfter = mergeAXData(hydratedAfter);
    const filteredAfter = filterNodes(mergedAfter.nodes);
    const snapAfter = buildSnapshotOutput(filteredAfter, mergedAfter.axIdToUid);

    let sendProposal = null;
    for (const [, node] of snapAfter.idToNode) {
      if (/send proposal/i.test(node.name)) {
        sendProposal = node;
        break;
      }
    }
    check('Send Proposal in snapshot after hover', !!sendProposal,
      sendProposal ? `[${sendProposal.role}] "${sendProposal.name}"` : 'not found');

    // Move mouse away to clean up
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await sleep(300);
  } else {
    console.log('  No .discovery-card on current page — skipping hover test');
    console.log('  (Navigate to partner discovery page to test hover)');
  }

  // ── Test 5: children resolution correctness ───────────────────────
  console.log('\nTEST 5: children resolution');
  console.log('-'.repeat(50));

  let nodesWithChildren = 0;
  let brokenRefs = 0;
  for (const [, node] of snapshot.idToNode) {
    if (node.children?.length) {
      nodesWithChildren++;
      for (const childUid of node.children) {
        if (!snapshot.idToNode.has(childUid)) brokenRefs++;
      }
    }
  }
  check('nodes with children exist', nodesWithChildren > 0, `${nodesWithChildren} parents`);
  check('no broken children references', brokenRefs === 0, brokenRefs > 0 ? `${brokenRefs} broken refs` : '');

  // ── Summary ───────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(50));
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));

  await cdp.detach();
  browser.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('[verify] Fatal:', err.message); process.exit(1); });
