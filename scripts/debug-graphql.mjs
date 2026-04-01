/**
 * Debug script: dump raw GraphQL response structure to find correct field paths.
 * Usage: pnpm run build && node scripts/debug-graphql.mjs
 */
import { ensureBrowser } from '../dist/browser/browser.js';
import { PuppeteerBackend } from '../dist/primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../dist/primitives/throttle.js';
import { checkLogin } from '../dist/sites/twitter/workflows.js';
import { writeFileSync } from 'fs';

const browser = await ensureBrowser();
const backend = new PuppeteerBackend(browser);
const primitives = createThrottledPrimitives(backend, { minDelay: 500, maxDelay: 1000 });

// Check login first
const { loggedIn } = await checkLogin(primitives);
if (!loggedIn) {
  console.error('Not logged in');
  process.exit(1);
}

// Set up interception to capture raw response
let captured = null;
const cleanup = await primitives.interceptRequest(
  /\/i\/api\/graphql\/.*\/Home.*Timeline/,
  (response) => {
    if (!captured) {
      captured = response.body;
    }
  },
  'twitter',
);

// Navigate to trigger fresh GraphQL request
await primitives.navigate('https://x.com/home', 'twitter');
await new Promise(r => setTimeout(r, 3000));
cleanup();

if (!captured) {
  console.error('No GraphQL response captured');
  process.exit(1);
}

const data = JSON.parse(captured);
const instructions = data?.data?.home?.home_timeline_urt?.instructions ?? [];

// Find first tweet entry and dump its structure
for (const inst of instructions) {
  for (const entry of (inst.entries ?? [])) {
    const content = entry.content;
    if (content?.entryType !== 'TimelineTimelineItem') continue;
    if (content.itemContent?.promotedMetadata) continue;

    const result = content.itemContent?.tweet_results?.result;
    if (!result) continue;

    // Dump the full tweet result to see actual structure
    console.log('=== First tweet result keys ===');
    console.log('__typename:', result.__typename);
    console.log('\nTop-level keys:', Object.keys(result));

    // Check for user info at various paths
    const core = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
    console.log('\nCore keys:', Object.keys(core || {}));
    console.log('core.core:', JSON.stringify(core?.core, null, 2)?.slice(0, 500));
    console.log('\nlegacy.full_text:', core?.legacy?.full_text?.slice(0, 80));
    console.log('legacy.user_id_str:', core?.legacy?.user_id_str);

    // Save full first entry to file for inspection
    writeFileSync('debug-tweet.json', JSON.stringify(result, null, 2));
    console.log('\nFull structure saved to debug-tweet.json');
    break;
  }
  if (captured) break;
}

process.exit(0);
