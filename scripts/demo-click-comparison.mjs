/**
 * Click Enhancement Comparison Demo
 *
 * Launches Chrome, opens the mouse-event-probe page, and runs 6 click modes
 * against target elements. After each mode, reads event data from the page
 * and prints a comparison table.
 *
 * Usage: node scripts/demo-click-comparison.mjs
 */
import { ensureBrowser, closeBrowser } from '../dist/browser/browser.js';
import { injectCoordFix, clickWithTrajectory, checkOcclusion, waitForElementStable } from '../dist/primitives/click-enhanced.js';
import { analyzeTrajectory } from '../dist/diagnose/trajectory-analyzer.js';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.resolve(__dirname, 'mouse-event-probe.html');
const PROBE_URL = `file://${PROBE_PATH.replace(/\\/g, '/')}`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
function waitForEnter(msg = '\n  Press Enter to continue...') {
  return new Promise((resolve) => rl.question(msg, () => resolve()));
}

function printResults(label, results) {
  console.log(`\n  ${label}`);
  console.log('  ' + '-'.repeat(56));
  console.log(`  mousemove count : ${results.moveCount}`);
  console.log(`  click count     : ${results.clickCount}`);
  console.log(`  coord mismatches: ${results.coordMismatches}`);
  if (results.events.length > 0) {
    const clicks = results.events.filter(e => e.type === 'click');
    if (clicks.length > 0) {
      const c = clicks[clicks.length - 1];
      console.log(`  last click      : (${c.clientX}, ${c.clientY}) screenX=${c.screenX} screenY=${c.screenY} coordOk=${c.coordOk}`);
    }
  }
}

function printHumannessReport(results, targetRect) {
  const moves = results.events
    .filter(e => e.type === 'mousemove')
    .map(e => ({ x: e.clientX, y: e.clientY, timestamp: e.timestamp }));

  const clicks = results.events.filter(e => e.type === 'click');
  if (clicks.length === 0) {
    console.log('\n  Humanness Analysis: no click events recorded');
    return;
  }

  const lastClick = clicks[clicks.length - 1];
  const click = { x: lastClick.clientX, y: lastClick.clientY, timestamp: lastClick.timestamp };
  const target = {
    x: targetRect.x + targetRect.width / 2,
    y: targetRect.y + targetRect.height / 2,
    width: targetRect.width,
    height: targetRect.height,
  };

  const report = analyzeTrajectory(moves, click, target);

  console.log('\n  Humanness Analysis');
  console.log('  ' + '-'.repeat(56));

  if (moves.length < 3) {
    console.log('  (insufficient trajectory data for full analysis)');
  }

  for (const c of report.checks) {
    const status = c.pass ? 'PASS' : 'FAIL';
    const pad = c.name.length < 20 ? ' '.repeat(20 - c.name.length) : ' ';
    let detail;
    if (c.threshold.min != null && c.threshold.max != null) {
      detail = `${c.value.toFixed(1)}px, ${c.threshold.min}-${c.threshold.max.toFixed(0)}px`;
    } else if (c.threshold.min != null) {
      detail = `${c.value.toFixed(2)}, >${c.threshold.min}`;
    } else {
      detail = `${c.value.toFixed(2)}, <${c.threshold.max}`;
    }
    const ref = `[${c.reference}]`;
    console.log(`  ${c.name}${pad}:  ${status}  (${detail})  ${ref}`);
  }

  const passCount = report.checks.filter(c => c.pass).length;
  console.log('  ' + '-'.repeat(56));
  console.log(`  Score: ${passCount}/${report.checks.length} (${report.overallScore.toFixed(2)})`);
}

async function getResults(page) {
  return page.evaluate(() => window.__probeResults);
}

async function resetProbe(page) {
  await page.evaluate(() => window.resetProbe?.() ?? document.querySelector('#header button')?.click());
  await new Promise(r => setTimeout(r, 200));
}

async function getBackendNodeId(page, selector) {
  const client = await page.createCDPSession();
  try {
    const doc = await client.send('DOM.getDocument');
    const node = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    const desc = await client.send('DOM.describeNode', { nodeId: node.nodeId });
    return desc.node.backendNodeId;
  } finally {
    await client.detach();
  }
}

async function getButtonCenter(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('target-btn');
    const rect = btn.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
}

async function getButtonRect(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('target-btn');
    const rect = btn.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function main() {
  console.log('\n  Click Enhancement Comparison Demo');
  console.log('  ' + '='.repeat(40));

  const browser = await ensureBrowser();

  // Each mode uses a fresh page to avoid evaluateOnNewDocument leaking between modes
  async function runMode(label, setup) {
    console.log(`\n  ${label}`);
    const pg = await browser.newPage();
    if (setup) await setup(pg);
    await pg.goto(PROBE_URL, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 500));
    const btn = await getButtonCenter(pg);
    return { pg, btn };
  }

  // ── Mode 1: Vanilla Puppeteer click ──
  const m1 = await runMode('MODE 1: Vanilla Puppeteer click (no enhancements)');
  const m1rect = await getButtonRect(m1.pg);
  await m1.pg.mouse.click(m1.btn.x, m1.btn.y);
  await new Promise(r => setTimeout(r, 300));
  const m1results = await getResults(m1.pg);
  printResults('Vanilla click', m1results);
  printHumannessReport(m1results, m1rect);
  await waitForEnter();
  await m1.pg.close();

  // ── Mode 2: With coordinate fix ──
  const m2 = await runMode('MODE 2: With screenX/screenY coordinate fix', (pg) => injectCoordFix(pg));
  const m2rect = await getButtonRect(m2.pg);
  await m2.pg.mouse.click(m2.btn.x, m2.btn.y);
  await new Promise(r => setTimeout(r, 300));
  const m2results = await getResults(m2.pg);
  printResults('With coord fix', m2results);
  printHumannessReport(m2results, m2rect);
  await waitForEnter();
  await m2.pg.close();

  // ── Mode 3: With Bezier trajectory (no coord fix, no jitter) ──
  const m3 = await runMode('MODE 3: With Bezier trajectory (no jitter)');
  const m3rect = await getButtonRect(m3.pg);
  await clickWithTrajectory(m3.pg, m3.btn.x, m3.btn.y, { jitter: false });
  await new Promise(r => setTimeout(r, 300));
  const m3results = await getResults(m3.pg);
  printResults('With trajectory', m3results);
  printHumannessReport(m3results, m3rect);
  await waitForEnter();
  await m3.pg.close();

  // ── Mode 4: Full enhancement (coord fix + trajectory + jitter) ──
  const m4 = await runMode('MODE 4: Full enhancement (coord fix + trajectory + jitter)', (pg) => injectCoordFix(pg));
  const m4rect = await getButtonRect(m4.pg);
  await clickWithTrajectory(m4.pg, m4.btn.x, m4.btn.y, { jitter: true });
  await new Promise(r => setTimeout(r, 300));
  const m4results = await getResults(m4.pg);
  printResults('Full enhancement', m4results);
  printHumannessReport(m4results, m4rect);
  await waitForEnter();
  await m4.pg.close();

  // ── Mode 5: Occlusion detection ──
  const m5 = await runMode('MODE 5: Occlusion detection');
  // Enable the occluder overlay to cover the target button
  await m5.pg.evaluate(() => window.setOccluder(true));
  await new Promise(r => setTimeout(r, 300));

  // Get target button's backendNodeId via CDP
  const m5BackendNodeId = await getBackendNodeId(m5.pg, '#target-btn');

  const m5Btn = await getButtonCenter(m5.pg);
  const occlusionResult = await checkOcclusion(m5.pg, m5Btn.x, m5Btn.y, m5BackendNodeId);
  console.log(`\n  Occlusion detection`);
  console.log('  ' + '-'.repeat(56));
  console.log(`  occluded        : ${occlusionResult.occluded}`);
  console.log(`  fallback coords : ${occlusionResult.fallback ? `(${occlusionResult.fallback.x}, ${occlusionResult.fallback.y})` : 'none'}`);

  // Now remove occluder and re-check
  await m5.pg.evaluate(() => window.setOccluder(false));
  await new Promise(r => setTimeout(r, 200));
  const clearResult = await checkOcclusion(m5.pg, m5Btn.x, m5Btn.y, m5BackendNodeId);
  console.log(`  after removing  : occluded=${clearResult.occluded}`);
  await waitForEnter();
  await m5.pg.close();

  // ── Mode 6: Animation stability wait ──
  const m6 = await runMode('MODE 6: Animation stability wait');
  // Get animated button's backendNodeId
  const m6BackendNodeId = await getBackendNodeId(m6.pg, '#animated-btn');

  // Trigger the slide-in animation
  await m6.pg.evaluate(() => window.triggerAnimation());
  console.log('\n  Animation stability wait');
  console.log('  ' + '-'.repeat(56));
  console.log('  Animation triggered, waiting for element to stabilize...');
  const startMs = Date.now();
  const stablePos = await waitForElementStable(m6.pg, m6BackendNodeId);
  const elapsed = Date.now() - startMs;
  console.log(`  Stabilized at   : (${stablePos.x.toFixed(0)}, ${stablePos.y.toFixed(0)}) after ${elapsed}ms`);
  console.log(`  (animation is 2000ms, so wait should be ~2000ms)`);

  // Click the stabilized element
  await m6.pg.mouse.click(stablePos.x, stablePos.y);
  await new Promise(r => setTimeout(r, 300));
  printResults('After stability wait', await getResults(m6.pg));
  await waitForEnter();
  await m6.pg.close();

  // ── Mode 7: Integrated primitives.click(uid) ──
  console.log('\n  MODE 7: Integrated primitives.click(uid)');
  const { PuppeteerBackend } = await import('../dist/primitives/puppeteer-backend.js');
  const m7backend = new PuppeteerBackend(browser);
  await m7backend.navigate(PROBE_URL, 'probe');
  await new Promise(r => setTimeout(r, 500));

  // Take snapshot to get uid for the target button
  const snapshot = await m7backend.takeSnapshot('probe');
  const targetNode = Array.from(snapshot.idToNode.values()).find(
    n => n.role === 'button' && n.name === 'CLICK ME'
  );

  if (targetNode) {
    console.log(`  Found target button: uid=${targetNode.uid}, role=${targetNode.role}, name="${targetNode.name}"`);
    const m7page = await m7backend.getRawPage('probe');
    const m7rect = await getButtonRect(m7page);
    await m7backend.click(targetNode.uid, 'probe');
    await new Promise(r => setTimeout(r, 300));

    const m7results = await getResults(m7page);
    printResults('Integrated click', m7results);
    printHumannessReport(m7results, m7rect);
  } else {
    console.log('  ERROR: Could not find target button in snapshot');
  }
  await waitForEnter();
  const m7pageFinal = await m7backend.getRawPage('probe');
  await m7pageFinal.close();

  // ── Summary ──
  console.log('\n\n  ' + '='.repeat(40));
  console.log('  EXPECTED DIFFERENCES:');
  console.log('  Mode 1: 0 mousemove, coord mismatch likely');
  console.log('  Mode 2: 0 mousemove, coord mismatch fixed');
  console.log('  Mode 3: 10+ mousemove, visible trajectory on canvas');
  console.log('  Mode 4: 10+ mousemove, coord fixed, click offset from center');
  console.log('  Mode 5: Detects occluder, provides fallback coordinates');
  console.log('  Mode 6: Waits ~2s for animation, then clicks stable position');
  console.log('  Mode 7: Integrated primitives.click(uid) — full pipeline');
  console.log('  ' + '='.repeat(40));

  await waitForEnter('\n  Press Enter to close browser...');
  closeBrowser();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  closeBrowser();
  rl.close();
  process.exit(1);
});
