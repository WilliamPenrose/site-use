#!/usr/bin/env node
/**
 * Verify Twitter Following page GraphQL endpoint via CDP.
 * Uses loadingFinished to ensure response body is available.
 *
 * Usage: node scripts/verify-following-api.mjs <handle>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const handle = process.argv[2];
if (!handle) {
  console.error('Usage: node scripts/verify-following-api.mjs <handle>');
  process.exit(1);
}

const chromeJsonPath = path.join(os.homedir(), '.site-use', 'chrome.json');
const { wsEndpoint } = JSON.parse(fs.readFileSync(chromeJsonPath, 'utf-8'));

console.log(`Connecting to Chrome via ${wsEndpoint}`);
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
const client = await page.createCDPSession();
await client.send('Network.enable');

// Track responses and their URLs
const responseUrls = new Map(); // requestId -> url
const captured = [];

client.on('Network.responseReceived', (event) => {
  const { requestId, response } = event;
  if (response.url.includes('/i/api/graphql/')) {
    responseUrls.set(requestId, response.url);
  }
});

client.on('Network.loadingFinished', async (event) => {
  const { requestId } = event;
  const url = responseUrls.get(requestId);
  if (!url) return;

  const opMatch = url.match(/\/graphql\/[^/]+\/([^?]+)/);
  const opName = opMatch ? opMatch[1] : 'unknown';

  // Only care about Following endpoint
  if (!opName.includes('Following') && opName !== 'UserByScreenName') return;

  try {
    const { body } = await client.send('Network.getResponseBody', { requestId });
    const parsed = JSON.parse(body);
    captured.push({ opName, url, body: parsed });
    console.log(`✓ Captured ${opName} (${JSON.stringify(body).length} bytes)`);
  } catch (err) {
    console.error(`✗ ${opName}: ${err.message}`);
  }
});

const followingUrl = `https://x.com/${handle}/following`;
console.log(`Navigating to ${followingUrl}`);
await page.goto(followingUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));

// Scroll to trigger pagination
console.log('Scrolling...');
await page.evaluate(() => window.scrollBy(0, 3000));
await new Promise(r => setTimeout(r, 4000));

console.log(`\n=== Captured ${captured.length} responses ===\n`);

for (const { opName, url, body } of captured) {
  if (opName !== 'Following') continue;

  console.log(`--- ${opName} ---`);

  // Extract variables from URL
  const varsMatch = url.match(/variables=([^&]+)/);
  if (varsMatch) {
    const vars = JSON.parse(decodeURIComponent(varsMatch[1]));
    console.log('Variables:', JSON.stringify(vars, null, 2));
  }

  // Dig into the response structure
  const timeline = body?.data?.user?.result?.timeline?.timeline;
  if (!timeline) {
    console.log('Unexpected structure. Keys:', JSON.stringify(Object.keys(body?.data || {})));
    continue;
  }

  console.log('Timeline keys:', Object.keys(timeline));
  const instructions = timeline.instructions || [];
  console.log('Instructions count:', instructions.length);

  for (const inst of instructions) {
    console.log(`  Instruction type: ${inst.type}`);
    if (inst.entries) {
      console.log(`  Entries count: ${inst.entries.length}`);
      let userCount = 0;
      for (const entry of inst.entries) {
        const content = entry.content;
        if (content?.entryType === 'TimelineTimelineItem') {
          const userResult = content?.itemContent?.user_results?.result;
          if (userResult) {
            userCount++;
            if (userCount <= 3) {
              const legacy = userResult.legacy || {};
              const core = userResult.core || {};
              console.log(`\n  User ${userCount}:`);
              console.log('    handle:', core.screen_name);
              console.log('    name:', core.name);
              console.log('    bio:', (legacy.description || '').slice(0, 80));
              console.log('    followers:', legacy.followers_count);
              console.log('    following:', legacy.friends_count);
              console.log('    verified:', userResult.is_blue_verified);
              console.log('    avatar:', legacy.profile_image_url_https ? 'yes' : 'no');
              console.log('    relationship_perspectives:', userResult.relationship_perspectives ? JSON.stringify(userResult.relationship_perspectives) : 'N/A');

              if (userCount === 1) {
                console.log('\n    [First user full keys]');
                console.log('    result keys:', Object.keys(userResult));
                console.log('    legacy keys:', Object.keys(legacy));
                console.log('    core keys:', Object.keys(core));
              }
            }
          }
        }
        // Cursor entries
        if (content?.entryType === 'TimelineTimelineCursor') {
          console.log(`\n  Cursor: ${content.cursorType} = ${(content.value || '').slice(0, 80)}...`);
        }
      }
      console.log(`\n  Total users in page: ${userCount}`);
    }
  }
}

// Save full data
const outPath = path.join(os.tmpdir(), `following-${handle}.json`);
fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
console.log(`\nFull responses saved to: ${outPath}`);

await client.send('Network.disable');
browser.disconnect();
console.log('Done.');
