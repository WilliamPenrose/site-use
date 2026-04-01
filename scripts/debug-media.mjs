/**
 * Debug script: compare raw GraphQL extended_entities with parsed media output.
 * Run: node scripts/debug-media.mjs
 */
import { ensureBrowser, closeBrowser } from '../dist/browser/browser.js';
import { PuppeteerBackend } from '../dist/primitives/puppeteer-backend.js';
import { parseGraphQLTimeline } from '../dist/sites/twitter/extractors.js';

const GRAPHQL_TIMELINE_RE = /\/i\/api\/graphql\/.*\/Home.*Timeline/;
const TWITTER_SITE = 'twitter';

async function main() {
  const browser = await ensureBrowser();
  const backend = new PuppeteerBackend(browser);

  // Collect raw GraphQL bodies
  const rawBodies = [];

  await backend.interceptRequest(
    GRAPHQL_TIMELINE_RE,
    (resp) => { rawBodies.push(resp.body); },
    TWITTER_SITE,
  );

  await backend.navigate('https://x.com/home', TWITTER_SITE);
  console.log('Navigated to timeline, waiting for GraphQL responses...');
  await new Promise(r => setTimeout(r, 5000));

  // Scroll once to get more data
  await backend.scroll({ direction: 'down' }, TWITTER_SITE);
  await new Promise(r => setTimeout(r, 3000));

  console.log(`\nCaptured ${rawBodies.length} GraphQL response(s)\n`);

  for (const body of rawBodies) {
    const data = JSON.parse(body);
    const instructions = data?.data?.home?.home_timeline_urt?.instructions ?? [];

    for (const instruction of instructions) {
      for (const entry of (instruction.entries ?? [])) {
        const content = entry.content;
        if (content?.entryType !== 'TimelineTimelineItem') continue;
        if (content.itemContent?.promotedMetadata) continue;

        let tweetResult = content.itemContent?.tweet_results?.result;
        if (!tweetResult) continue;

        // Unwrap TweetWithVisibilityResults
        if (tweetResult.__typename === 'TweetWithVisibilityResults') {
          tweetResult = tweetResult.tweet;
        }

        const legacy = tweetResult?.legacy;
        if (!legacy) continue;

        const userInfo = tweetResult?.core?.user_results?.result?.core
          ?? tweetResult?.core?.user_results?.result?.legacy;
        const handle = userInfo?.screen_name ?? '???';
        const idStr = legacy.id_str ?? tweetResult.rest_id ?? '???';

        // Raw media from GraphQL
        const rawMedia = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
        const hasRawMedia = rawMedia.length > 0;

        // Our parsed result
        const parsed = parseGraphQLTimeline(JSON.stringify({
          data: { home: { home_timeline_urt: { instructions: [{ entries: [entry] }] } } }
        }));
        const parsedMedia = parsed[0]?.media ?? [];

        // Compare
        const match = rawMedia.length === parsedMedia.length;
        const icon = match ? '✓' : '✗';

        if (hasRawMedia || parsedMedia.length > 0) {
          console.log(`${icon} @${handle} (${idStr}): raw=${rawMedia.length} media, parsed=${parsedMedia.length} media`);
          for (const m of rawMedia) {
            console.log(`    raw: type=${m.type} url=${m.media_url_https?.slice(0, 60)}... alt=${m.ext_alt_text ?? '(none)'}`);
          }
          for (const m of parsedMedia) {
            console.log(`    parsed: type=${m.type} url=${m.mediaUrl?.slice(0, 60)}...`);
          }
        } else {
          console.log(`${icon} @${handle} (${idStr}): no media (confirmed)`);
        }
      }
    }
  }

  console.log('\nDone. Detaching...');
  closeBrowser();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
