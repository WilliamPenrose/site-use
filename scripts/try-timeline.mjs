/**
 * Quick script to try getTimeline manually.
 *
 * Usage:
 *   1. pnpm run build
 *   2. node scripts/try-timeline.mjs [count]
 *
 * Example:
 *   node scripts/try-timeline.mjs 5      # fetch 5 tweets
 *   node scripts/try-timeline.mjs        # defaults to 5
 *
 * Prerequisites:
 *   - Must be logged in to x.com in the site-use Chrome profile.
 *   - If not, run: node dist/index.js browser launch
 *     then log in manually in the Chrome window, then Ctrl+C.
 */
import { ensureBrowser } from '../dist/browser/browser.js';
import { PuppeteerBackend } from '../dist/primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from '../dist/primitives/throttle.js';
import { getTimeline } from '../dist/sites/twitter/workflows.js';

const count = parseInt(process.argv[2], 10) || 5;

const browser = await ensureBrowser();

// Close blank tabs left over from previous runs (keep tabs with real content)
const existingPages = await browser.pages();
for (const p of existingPages) {
  const url = p.url();
  if (url === 'about:blank' || url === 'chrome://new-tab-page/') {
    await p.close().catch(() => {});
  }
}

const backend = new PuppeteerBackend(browser);
const primitives = createThrottledPrimitives(backend, {
  minDelay: 800,
  maxDelay: 1500,
});

console.log(`Fetching ${count} tweets from timeline...`);
console.log('(GraphQL interception + humanized scroll)\n');

try {
  const result = await getTimeline(primitives, count);

  console.log(`Got ${result.tweets.length} tweets from ${result.meta.coveredUserCount} users\n`);

  for (const tweet of result.tweets) {
    const metrics = [
      tweet.metrics.likes != null ? `${tweet.metrics.likes} likes` : null,
      tweet.metrics.retweets != null ? `${tweet.metrics.retweets} RT` : null,
    ].filter(Boolean).join(', ');

    console.log(`@${tweet.author.handle} (${tweet.author.name})`);
    console.log(`  ${tweet.text.slice(0, 120)}${tweet.text.length > 120 ? '...' : ''}`);
    console.log(`  ${metrics} | ${tweet.timestamp}`);
    console.log(`  ${tweet.url}\n`);
  }

  console.log('--- Meta ---');
  console.log(`Tweets: ${result.meta.tweetCount}`);
  console.log(`Users: ${result.meta.coveredUsers.join(', ')}`);
  console.log(`Time range: ${result.meta.timeRange.from} ~ ${result.meta.timeRange.to}`);
} catch (err) {
  console.error('Failed:', err.message);
  if (err.type === 'SessionExpired') {
    console.error('\nNot logged in. Run: node dist/index.js browser launch');
    console.error('Then log in to x.com in the Chrome window.');
  }
}

process.exit(0);
