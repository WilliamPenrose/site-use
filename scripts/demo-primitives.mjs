/**
 * Primitives layer demo — launches browser and walks through each primitive
 * with visible output so you can see what's happening.
 *
 * Usage: node scripts/demo-primitives.mjs [url]
 *   Default URL: https://en.wikipedia.org/wiki/Web_scraping
 */
import { ensureBrowser, closeBrowser } from '../dist/browser/browser.js';
import { PuppeteerBackend } from '../dist/primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../dist/primitives/throttle.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const TARGET_URL = process.argv[2] || 'https://en.wikipedia.org/wiki/Web_scraping';

// --- Helpers ---

const rl = createInterface({ input: process.stdin, output: process.stdout });

function waitForEnter() {
  return new Promise((resolve) => {
    rl.question('\n  Press Enter to continue...', () => resolve());
  });
}

function step(n, title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Step ${n}: ${title}`);
  console.log('='.repeat(60));
}

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  console.log('Primitives Layer Demo');
  console.log(`Target: ${TARGET_URL}\n`);

  // ── Init: launch browser + create primitives ──
  console.log('  Launching Chrome...');
  const browser = await ensureBrowser();
  const pid = browser.process()?.pid;
  console.log(`  Chrome launched (PID: ${pid})`);
  const raw = new PuppeteerBackend(browser);
  const primitives = createThrottledPrimitives(raw, { minDelay: 200, maxDelay: 500 });
  console.log('  Primitives ready (200-500ms throttle)\n');

  // ── Step 1: Navigate ──
  step(1, 'navigate — open page');
  console.log(`  Navigating to ${TARGET_URL}...`);
  await primitives.navigate(TARGET_URL, 'demo');
  const title = await primitives.evaluate('document.title', 'demo');
  const dims = await primitives.evaluate(
    'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
    'demo',
  );
  console.log(`  Page loaded: "${title}"  |  Viewport: ${dims}`);
  await waitForEnter();

  // ── Step 2: Take snapshot ──
  step(2, 'takeSnapshot — CDP Accessibility tree → uid map');
  const snapshot = await primitives.takeSnapshot('demo');
  console.log(`  Total nodes: ${snapshot.idToNode.size}`);

  // Show first 15 interesting nodes (links and headings)
  const interesting = [];
  for (const [uid, node] of snapshot.idToNode) {
    if (['link', 'heading'].includes(node.role) && node.name.trim()) {
      interesting.push({ uid, role: node.role, name: node.name.slice(0, 60) });
    }
    if (interesting.length >= 15) break;
  }
  console.log('\n  Sample nodes (links & headings):');
  console.log('  UID  | Role    | Name');
  console.log('  ' + '-'.repeat(55));
  for (const n of interesting) {
    console.log(`  ${n.uid.padEnd(5)}| ${n.role.padEnd(8)}| ${n.name}`);
  }
  await waitForEnter();

  // ── Step 3: Click ──
  step(3, 'click — click a link by uid');
  // Find "About Wikipedia" link to click
  let clickTarget = null;
  for (const [uid, node] of snapshot.idToNode) {
    if (node.role === 'link' && node.name === 'About Wikipedia') {
      clickTarget = { uid, name: node.name };
      break;
    }
  }

  if (clickTarget) {
    console.log(`  Scrolling to footer to make link visible...`);
    await primitives.evaluate(
      'document.querySelector("footer")?.scrollIntoView({ behavior: "smooth" })',
      'demo',
    );
    await pause(1000);

    // Re-snapshot after scroll so uid coordinates are fresh
    console.log('  Re-taking snapshot for updated coordinates...');
    const snap2 = await primitives.takeSnapshot('demo');
    let freshUid = null;
    for (const [uid, node] of snap2.idToNode) {
      if (node.role === 'link' && node.name === 'About Wikipedia') {
        freshUid = uid;
        break;
      }
    }

    console.log(`  Clicking uid=${freshUid}: "${clickTarget.name}"`);
    try {
      await primitives.click(freshUid, 'demo');
      // Wait for actual navigation to complete
      const page = await raw.getRawPage('demo');
      await page.waitForNavigation({ waitUntil: 'load', timeout: 10_000 }).catch(() => {});
      const newTitle = await primitives.evaluate('document.title', 'demo');
      console.log(`  Page changed → "${newTitle}"`);
    } catch (err) {
      console.log(`  Click failed: ${err.message}`);
    }
  } else {
    console.log('  No "About Wikipedia" link found, skipping.');
  }
  await waitForEnter();

  // ── Step 4: Navigate back for more demos ──
  step(4, 'navigate — go back to original page');
  await primitives.navigate(TARGET_URL, 'demo');
  console.log('  Back on original page.');
  await waitForEnter();

  // ── Step 5: Scroll ──
  step(5, 'scroll — progressive scroll down then up');
  console.log('  Scrolling down 600px (3 steps)...');
  await primitives.scroll({ direction: 'down' }, 'demo');
  const scrollY1 = await primitives.evaluate('window.scrollY', 'demo');
  console.log(`  scrollY after down: ${scrollY1}px`);

  console.log('  Scrolling up 300px...');
  await primitives.scroll({ direction: 'up', amount: 300 }, 'demo');
  const scrollY2 = await primitives.evaluate('window.scrollY', 'demo');
  console.log(`  scrollY after up: ${scrollY2}px`);
  await waitForEnter();

  // ── Step 6: Intercept request ──
  step(6, 'interceptRequest — capture network responses');
  const captured = [];
  console.log('  Setting up interceptor (matching all responses)...');
  const cleanup = await primitives.interceptRequest(
    // Broad match to catch anything
    /./,
    (resp) => {
      captured.push({ url: resp.url.slice(0, 80), status: resp.status });
    },
    'demo',
  );

  // Navigate to a fresh page to guarantee network traffic
  console.log('  Navigating to httpbin.org to trigger fresh requests...');
  await raw.navigate('https://httpbin.org/html', 'demo');
  await pause(2000);

  cleanup(); // Remove listener
  console.log(`  Captured ${captured.length} responses:`);
  for (const r of captured.slice(0, 8)) {
    console.log(`    [${r.status}] ${r.url}`);
  }
  if (captured.length > 8) {
    console.log(`    ... and ${captured.length - 8} more`);
  }
  if (captured.length === 0) {
    console.log('    (no responses captured — page may have been fully cached)');
  }
  await waitForEnter();

  // ── Step 7: Screenshot ──
  step(7, 'screenshot — capture page as base64 PNG');
  // Navigate back to Wikipedia for a meaningful screenshot
  console.log('  Navigating back to Wikipedia...');
  await primitives.navigate(TARGET_URL, 'demo');

  const base64 = await primitives.screenshot('demo');
  console.log(`  Base64 length: ${base64.length} chars`);

  // Save to temp file so user can view it
  const screenshotPath = join(tmpdir(), 'site-use-demo-screenshot.png');
  writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
  console.log(`  Saved to: ${screenshotPath}`);

  // ── Done ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Demo complete! All 7 primitives exercised.');
  console.log('  (type is deferred to M2)');
  console.log('='.repeat(60));
  console.log('\nDetaching from Chrome (stays open)...');
  rl.close();
  closeBrowser();
}

main().catch((err) => {
  console.error('Demo failed:', err);
  closeBrowser();
  process.exit(1);
});
