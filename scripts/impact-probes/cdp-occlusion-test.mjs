#!/usr/bin/env node
/**
 * Test checkOcclusion behavior for iframe elements.
 *
 * 1. Find an interactive element inside the iframe (e.g. a button)
 * 2. Call DOM.getNodeForLocation WITHOUT pierce — expect to get iframe element (misMatch)
 * 3. Call DOM.getNodeForLocation WITH pierce — expect to get the actual button (match)
 * 4. Simulate the full click path (waitForElementStable → checkOcclusion → clickWithTrajectory)
 *    on an iframe element, see if it succeeds or fails
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

  // Verify iframe is open
  const iframeOpen = await page.evaluate(() => !!document.querySelector('iframe[src*="proposal"]'));
  if (!iframeOpen) { console.error('Iframe dialog not open. Run cdp-full-flow.mjs first.'); process.exit(1); }

  const cdp = await page.createCDPSession();

  // Find iframe frameId
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

  // Get iframe AX tree
  let iframeAx;
  for (let i = 0; i < 10; i++) {
    iframeAx = await cdp.send('Accessibility.getFullAXTree', { frameId: iframeId });
    const hasButtons = iframeAx.nodes.some(n => !n.ignored && n.role?.value === 'button');
    if (hasButtons) break;
    await sleep(500);
  }

  // Find the "Send Proposal" submit button and "Ongoing" button in iframe
  const testTargets = iframeAx.nodes.filter(n =>
    !n.ignored && n.role?.value === 'button' && n.backendDOMNodeId != null &&
    /send proposal|ongoing|select|AM/i.test(n.name?.value || '')
  );

  console.log('═'.repeat(70));
  console.log('TEST: checkOcclusion behavior for iframe elements');
  console.log('═'.repeat(70));
  console.log(`  Found ${testTargets.length} test targets in iframe\n`);

  for (const target of testTargets.slice(0, 4)) {
    const name = target.name?.value || '(unnamed)';
    const backendNodeId = target.backendDOMNodeId;

    console.log(`  ── [button] "${name}" (backendNodeId=${backendNodeId}) ──`);

    // Get element coordinates
    let cx, cy;
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
      const [x1, y1, , , x3, , , y4] = model.content;
      cx = Math.round((x1 + x3) / 2);
      cy = Math.round((y1 + y4) / 2);
      console.log(`    coordinates: (${cx}, ${cy})`);
    } catch (err) {
      console.log(`    getBoxModel FAILED: ${err.message}`);
      continue;
    }

    // Test 1: getNodeForLocation WITHOUT pierce
    try {
      const noPierce = await cdp.send('DOM.getNodeForLocation', {
        x: cx, y: cy,
        includeUserAgentShadowDOM: true,
      });
      const match = noPierce.backendNodeId === backendNodeId;
      console.log(`    WITHOUT pierce: backendNodeId=${noPierce.backendNodeId} ${match ? '✓ MATCH' : '✗ MISMATCH (would be "occluded")'}`);

      if (!match) {
        // What element did we get instead?
        try {
          const { node } = await cdp.send('DOM.describeNode', { backendNodeId: noPierce.backendNodeId });
          console.log(`      got instead: <${node.localName}> nodeId=${node.nodeId} ${node.localName === 'iframe' ? '← THIS IS THE IFRAME ELEMENT' : ''}`);
        } catch {}
      }
    } catch (err) {
      console.log(`    WITHOUT pierce: ERROR: ${err.message}`);
    }

    // Test 2: getNodeForLocation WITH pierce
    try {
      const withPierce = await cdp.send('DOM.getNodeForLocation', {
        x: cx, y: cy,
        includeUserAgentShadowDOM: true,
        pierce: true,
      });
      const match = withPierce.backendNodeId === backendNodeId;
      console.log(`    WITH pierce:    backendNodeId=${withPierce.backendNodeId} ${match ? '✓ MATCH' : '✗ MISMATCH'}`);

      if (!match) {
        try {
          const { node } = await cdp.send('DOM.describeNode', { backendNodeId: withPierce.backendNodeId });
          console.log(`      got instead: <${node.localName}>`);
        } catch {}
      }
    } catch (err) {
      console.log(`    WITH pierce:    ERROR: ${err.message}`);
    }

    console.log('');
  }

  // ── Now test actual click via the REAL click path ──────────────────
  console.log('═'.repeat(70));
  console.log('TEST: Actual click on iframe element via page.mouse.click');
  console.log('═'.repeat(70));

  // Pick a safe button to click — "Ongoing" (length selector, won't submit form)
  const safeBtn = testTargets.find(n => /ongoing/i.test(n.name?.value || ''));
  if (safeBtn) {
    const bid = safeBtn.backendDOMNodeId;
    console.log(`\n  Target: [button] "${safeBtn.name?.value}" backendNodeId=${bid}`);

    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: bid });
    const [x1, y1, , , x3, , , y4] = model.content;
    const clickX = (x1 + x3) / 2;
    const clickY = (y1 + y4) / 2;
    console.log(`  Coordinates: (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

    // Read button state before click
    const beforeState = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      const btns = iframe?.contentDocument?.querySelectorAll('button') ?? [];
      for (const b of btns) {
        if (/ongoing/i.test(b.textContent?.trim())) {
          return { text: b.textContent.trim(), classes: b.className.slice(0, 80), ariaPressed: b.getAttribute('aria-pressed') };
        }
      }
      return null;
    });
    console.log(`  Before click: ${JSON.stringify(beforeState)}`);

    // Click using page.mouse (same as clickWithTrajectory's final step)
    console.log(`  Clicking...`);
    await page.mouse.click(clickX, clickY);
    await sleep(300);

    // Read button state after click
    const afterState = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="proposal"]');
      const btns = iframe?.contentDocument?.querySelectorAll('button') ?? [];
      for (const b of btns) {
        if (/ongoing/i.test(b.textContent?.trim())) {
          return { text: b.textContent.trim(), classes: b.className.slice(0, 80), ariaPressed: b.getAttribute('aria-pressed') };
        }
      }
      return null;
    });
    console.log(`  After click:  ${JSON.stringify(afterState)}`);

    const classChanged = beforeState?.classes !== afterState?.classes;
    console.log(`  State changed: ${classChanged ? '✓ YES (click registered)' : '✗ NO'}`);
  } else {
    console.log('  No safe button found for click test');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('CONCLUSION');
  console.log('═'.repeat(70));

  await cdp.detach();
  browser.disconnect();
}

main().catch(err => { console.error('[probe] Fatal:', err.message); process.exit(1); });
