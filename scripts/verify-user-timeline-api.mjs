#!/usr/bin/env node
/**
 * Verify Twitter UserTweets and UserTweetsAndReplies GraphQL endpoints via CDP.
 * Reuses the site-use Chrome instance (reads wsEndpoint from ~/.site-use/chrome.json).
 *
 * Captures:
 *   1. All GraphQL endpoints fired when navigating to x.com/{handle} (default tab)
 *   2. UserTweets response structure — verify findInstructions compatibility
 *   3. Replies tab DOM structure (data-testid, tab text)
 *   4. UserTweetsAndReplies response after switching to Replies tab
 *   5. Entry-level structure: TimelineTimelineItem (flat) vs TimelineTimelineModule (grouped)
 *
 * Usage: node scripts/verify-user-timeline-api.mjs [screen_name]
 *   default screen_name: hwwaanng
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const screenName = process.argv[2] || 'hwwaanng';
const chromeJsonPath = path.join(os.homedir(), '.site-use', 'chrome.json');

if (!fs.existsSync(chromeJsonPath)) {
  console.error('chrome.json not found at', chromeJsonPath);
  process.exit(1);
}

const { wsEndpoint } = JSON.parse(fs.readFileSync(chromeJsonPath, 'utf-8'));
if (!wsEndpoint) {
  console.error('No wsEndpoint in chrome.json');
  process.exit(1);
}

console.log(`Connecting to Chrome via ${wsEndpoint}`);
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();

const client = await page.createCDPSession();
await client.send('Network.enable', {
  maxResourceBufferSize: 10 * 1024 * 1024,   // 10 MB per resource
  maxTotalBufferSize: 50 * 1024 * 1024,       // 50 MB total
});

// ── Phase 1: Capture all GraphQL endpoints on profile page load ──

const allEndpoints = [];
const capturedResponses = new Map(); // endpoint name → { url, body }
const pendingRequests = new Map();   // requestId → { endpointName, url }

client.on('Network.responseReceived', (event) => {
  const { requestId, response } = event;
  const graphqlMatch = response.url.match(/\/i\/api\/graphql\/[^/]+\/(\w+)/);
  if (!graphqlMatch) return;

  const endpointName = graphqlMatch[1];
  allEndpoints.push(endpointName);

  if (endpointName.includes('UserTweets') || endpointName.includes('UserMedia')) {
    pendingRequests.set(requestId, { endpointName, url: response.url });
  }
});

client.on('Network.loadingFinished', async (event) => {
  const { requestId } = event;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);

  try {
    const { body } = await client.send('Network.getResponseBody', { requestId });
    capturedResponses.set(pending.endpointName, { url: pending.url, body });
    console.log(`  ✓ Captured ${pending.endpointName}`);
  } catch (err) {
    console.error(`  ✗ Failed to get body for ${pending.endpointName}: ${err.message}`);
  }
});

const profileUrl = `https://x.com/${screenName}`;
console.log(`\n═══ Phase 1: Navigate to ${profileUrl} (default tab) ═══`);
await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

console.log('\n=== All GraphQL endpoints fired on profile page load ===');
console.log(allEndpoints);

// ── Phase 2: Analyze UserTweets response structure ──

for (const [name, { url, body }] of capturedResponses) {
  console.log(`\n═══ Phase 2: Analyzing ${name} response ═══`);
  console.log('  URL:', url.slice(0, 150) + '...');

  const data = JSON.parse(body);

  // Try to find instructions (same algorithm as site-use findInstructions)
  const instructions = findInstructions(data);
  if (instructions) {
    console.log('  ✓ findInstructions succeeded');
    console.log('  Instruction types:', instructions.map(i => i.type));

    const addEntries = instructions.find(i => i.type === 'TimelineAddEntries');
    if (addEntries?.entries) {
      console.log(`  Entry count: ${addEntries.entries.length}`);

      // Analyze entry types
      const entryTypes = {};
      for (const entry of addEntries.entries) {
        const type = entry.content?.entryType || 'unknown';
        entryTypes[type] = (entryTypes[type] || 0) + 1;

        // For modules, inspect internal structure
        if (type === 'TimelineTimelineModule' && entry.content?.items) {
          console.log(`\n  === Module entry: ${entry.entryId} ===`);
          console.log(`    Items in module: ${entry.content.items.length}`);
          for (const item of entry.content.items.slice(0, 3)) {
            const ic = item?.item?.itemContent;
            console.log(`    - __typename: ${ic?.__typename}, entryType: ${ic?.entryType || 'N/A'}`);
            if (ic?.tweet_results?.result?.legacy) {
              const text = ic.tweet_results.result.legacy.full_text?.slice(0, 80);
              console.log(`      text: "${text}..."`);
            }
          }
        }
      }
      console.log('  Entry types:', entryTypes);

      // Show first 2 tweet entries for structure verification
      console.log('\n  === First 2 tweet entries (structure sample) ===');
      let shown = 0;
      for (const entry of addEntries.entries) {
        if (shown >= 2) break;
        const ic = entry.content?.itemContent;
        if (ic?.__typename !== 'TimelineTweet') continue;
        const tr = ic.tweet_results?.result;
        if (!tr) continue;
        shown++;
        console.log(`\n  Entry ${shown}: ${entry.entryId}`);
        console.log('    __typename:', tr.__typename);
        console.log('    Has core:', !!tr.core);
        console.log('    Has legacy:', !!tr.legacy);
        console.log('    Has views:', !!tr.views);
        console.log('    Has retweeted_status_result:', !!tr.legacy?.retweeted_status_result);
        console.log('    Has quoted_status_result:', !!tr.quoted_status_result);
        console.log('    is_quote_status:', tr.legacy?.is_quote_status);
        console.log('    in_reply_to_status_id_str:', tr.legacy?.in_reply_to_status_id_str || null);
        const text = tr.legacy?.full_text?.slice(0, 100);
        console.log(`    text: "${text}"`);
      }
    }
  } else {
    console.log('  ✗ findInstructions returned null');
    console.log('  Top-level keys:', Object.keys(data));
    if (data.data) console.log('  data keys:', Object.keys(data.data));
  }

  // Save full response
  const outPath = path.join(os.tmpdir(), `${name}-${screenName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`  Saved to: ${outPath}`);
}

// ── Phase 3: Discover Replies tab DOM structure ──

console.log('\n═══ Phase 3: Replies tab DOM discovery ═══');

const tabInfo = await page.evaluate(() => {
  const tabs = document.querySelectorAll(
    '[data-testid="primaryColumn"] [role="tablist"] [role="tab"]'
  );
  return Array.from(tabs).map((tab, i) => ({
    index: i,
    text: tab.textContent?.trim() || '',
    ariaLabel: tab.getAttribute('aria-label') || null,
    ariaSelected: tab.getAttribute('aria-selected'),
    testid: tab.getAttribute('data-testid') || null,
    href: tab.closest('a')?.getAttribute('href') || null,
  }));
});

console.log('Tabs found:', tabInfo.length);
for (const t of tabInfo) {
  console.log(`  [${t.index}] text="${t.text}" aria-label=${t.ariaLabel} selected=${t.ariaSelected} testid=${t.testid} href=${t.href}`);
}

// Find replies tab
const repliesTab = tabInfo.find(t =>
  t.href?.includes('/with_replies') ||
  t.text.toLowerCase().includes('replies') ||
  t.text.toLowerCase().includes('返信')  // Japanese
);

if (!repliesTab) {
  console.log('  ✗ Could not identify Replies tab. Manual inspection needed.');
} else {
  console.log(`  ✓ Replies tab identified at index ${repliesTab.index}: "${repliesTab.text}"`);
}

// ── Phase 4: Click Replies tab and capture UserTweetsAndReplies ──

if (repliesTab) {
  console.log(`\n═══ Phase 4: Switching to Replies tab ═══`);

  // Clear previous captures for fresh interception
  const repliesCaptures = new Map();
  const repliesEndpoints = [];
  const repliesPending = new Map();

  const repliesResponseHandler = (event) => {
    const { requestId, response } = event;
    const graphqlMatch = response.url.match(/\/i\/api\/graphql\/[^/]+\/(\w+)/);
    if (!graphqlMatch) return;

    const endpointName = graphqlMatch[1];
    repliesEndpoints.push(endpointName);

    if (endpointName.includes('UserTweets') || endpointName.includes('Replies')) {
      repliesPending.set(requestId, { endpointName, url: response.url });
    }
  };

  const repliesFinishedHandler = async (event) => {
    const { requestId } = event;
    const pending = repliesPending.get(requestId);
    if (!pending) return;
    repliesPending.delete(requestId);

    try {
      const { body } = await client.send('Network.getResponseBody', { requestId });
      repliesCaptures.set(pending.endpointName, { url: pending.url, body });
      console.log(`  ✓ Captured ${pending.endpointName}`);
    } catch (err) {
      console.error(`  ✗ Failed to get body for ${pending.endpointName}: ${err.message}`);
    }
  };

  client.on('Network.responseReceived', repliesResponseHandler);
  client.on('Network.loadingFinished', repliesFinishedHandler);

  // Click the replies tab
  const tabs = await page.$$('[data-testid="primaryColumn"] [role="tablist"] [role="tab"]');
  if (tabs[repliesTab.index]) {
    await tabs[repliesTab.index].click();
    console.log('  Clicked Replies tab, waiting for response...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('\n=== GraphQL endpoints fired after Replies tab click ===');
  console.log(repliesEndpoints);

  // Analyze replies response
  for (const [name, { url, body }] of repliesCaptures) {
    console.log(`\n═══ Analyzing ${name} (replies tab) ═══`);
    console.log('  URL:', url.slice(0, 150) + '...');

    const data = JSON.parse(body);
    const instructions = findInstructions(data);

    if (instructions) {
      console.log('  ✓ findInstructions succeeded');
      console.log('  Instruction types:', instructions.map(i => i.type));

      const addEntries = instructions.find(i => i.type === 'TimelineAddEntries');
      if (addEntries?.entries) {
        console.log(`  Entry count: ${addEntries.entries.length}`);

        const entryTypes = {};
        const moduleDetails = [];

        for (const entry of addEntries.entries) {
          const type = entry.content?.entryType || 'unknown';
          entryTypes[type] = (entryTypes[type] || 0) + 1;

          // Deep inspect modules — this is the key question for #24
          if (type === 'TimelineTimelineModule' && entry.content?.items) {
            const items = entry.content.items;
            const detail = {
              entryId: entry.entryId,
              itemCount: items.length,
              items: items.slice(0, 5).map(item => {
                const ic = item?.item?.itemContent;
                const tr = ic?.tweet_results?.result;
                return {
                  __typename: ic?.__typename,
                  isReply: !!tr?.legacy?.in_reply_to_status_id_str,
                  in_reply_to: tr?.legacy?.in_reply_to_screen_name || null,
                  author: tr?.core?.user_results?.result?.core?.screen_name || null,
                  text: tr?.legacy?.full_text?.slice(0, 80) || null,
                };
              }),
            };
            moduleDetails.push(detail);
          }
        }

        console.log('  Entry types:', entryTypes);

        if (moduleDetails.length > 0) {
          console.log(`\n  === Module structure (${moduleDetails.length} modules) ===`);
          console.log('  ⚠ GROUPED STRUCTURE detected — replies are in TimelineTimelineModule');
          for (const mod of moduleDetails.slice(0, 3)) {
            console.log(`\n  Module: ${mod.entryId} (${mod.itemCount} items)`);
            for (const item of mod.items) {
              const label = item.isReply ? '↩ reply' : '📝 original';
              console.log(`    ${label} by @${item.author}: "${item.text}..."`);
            }
          }
        } else {
          console.log('\n  ✓ FLAT STRUCTURE — all entries are TimelineTimelineItem');
        }
      }
    } else {
      console.log('  ✗ findInstructions returned null');
      console.log('  Top-level keys:', Object.keys(data));
    }

    const outPath = path.join(os.tmpdir(), `${name}-replies-${screenName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`  Saved to: ${outPath}`);
  }

  client.off('Network.responseReceived', repliesResponseHandler);
  client.off('Network.loadingFinished', repliesFinishedHandler);
}

// ── Cleanup ──

await client.send('Network.disable');
browser.disconnect();
console.log('\n═══ Done (browser still running) ═══');

// ── Helpers ──

/**
 * Recursive search for `instructions` array (mirrors site-use findInstructions).
 */
function findInstructions(obj, maxDepth = 8) {
  if (maxDepth <= 0 || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'instructions' && Array.isArray(val)) {
      const hasTimelineType = val.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          typeof item.type === 'string' &&
          item.type.includes('Timeline'),
      );
      if (hasTimelineType) return val;
    }
    const found = findInstructions(val, maxDepth - 1);
    if (found) return found;
  }
  return null;
}
