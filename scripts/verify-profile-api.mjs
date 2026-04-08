#!/usr/bin/env node
/**
 * Verify Twitter UserByScreenName GraphQL endpoint via CDP.
 * Reuses the site-use Chrome instance (reads wsEndpoint from ~/.site-use/chrome.json).
 *
 * Usage: node scripts/verify-profile-api.mjs [screen_name]
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

// Use the first available page or create one
const pages = await browser.pages();
const page = pages[0] || await browser.newPage();

// Set up network interception to capture UserByScreenName response
const client = await page.createCDPSession();
await client.send('Network.enable');

let captured = null;
const requestBodies = new Map();

client.on('Network.responseReceived', async (event) => {
  const { requestId, response } = event;
  if (response.url.includes('UserByScreenName')) {
    console.log('\n✓ Captured UserByScreenName request');
    console.log('  URL:', response.url.slice(0, 120) + '...');
    console.log('  Status:', response.status);
    try {
      const { body } = await client.send('Network.getResponseBody', { requestId });
      captured = JSON.parse(body);
    } catch (err) {
      console.error('  Failed to get response body:', err.message);
    }
  }
});

// Navigate to the profile page
const profileUrl = `https://x.com/${screenName}`;
console.log(`Navigating to ${profileUrl}`);
await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });

// Wait a bit for any delayed API calls
await new Promise((r) => setTimeout(r, 3000));

if (!captured) {
  console.error('\n✗ No UserByScreenName response captured');
  await client.send('Network.disable');
  browser.disconnect();
  process.exit(1);
}

// Extract and display the relevant user data structure
console.log('\n=== Raw Response Structure (top-level keys) ===');
console.log(JSON.stringify(Object.keys(captured), null, 2));

const userResult = captured?.data?.user?.result;
if (!userResult) {
  console.log('\n✗ No data.user.result found. Full response:');
  console.log(JSON.stringify(captured, null, 2).slice(0, 2000));
} else {
  console.log('\n=== User Result Keys ===');
  console.log(Object.keys(userResult));

  const legacy = userResult.legacy;
  if (legacy) {
    console.log('\n=== Profile Info (legacy) ===');
    console.log({
      screen_name: legacy.screen_name,
      name: legacy.name,
      description: legacy.description,
      followers_count: legacy.followers_count,
      friends_count: legacy.friends_count,
      statuses_count: legacy.statuses_count,
      verified: legacy.verified,
      following: legacy.following,         // you follow them?
      followed_by: legacy.followed_by,     // they follow you?
      can_dm: legacy.can_dm,
    });

    console.log('\n=== Follow Relationship ===');
    console.log(`  You follow @${screenName}:`, legacy.following ?? 'N/A');
    console.log(`  @${screenName} follows you:`, legacy.followed_by ?? 'N/A');
  }

  // Save full response for analysis
  const outPath = path.join(os.tmpdir(), `profile-${screenName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
  console.log(`\nFull response saved to: ${outPath}`);
}

await client.send('Network.disable');
browser.disconnect();
console.log('\nDone (browser still running).');
