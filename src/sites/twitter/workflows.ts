import fs from 'node:fs';
import path from 'node:path';
import type { Primitives } from '../../primitives/types.js';
import { SessionExpired } from '../../errors.js';
import { matchByRule, rules } from './matchers.js';
import { makeEnsureState } from '../../ops/ensure-state.js';
import {
  collectTweetsFromTimeline,
  parseGraphQLTimeline,
  parseTweet,
  buildFeedMeta,
  GRAPHQL_TIMELINE_PATTERN,
} from './extractors.js';
import type { RawTweetData, FeedDebug, FeedResult } from './types.js';
import { tweetsToIngestItems } from './store-adapter.js';
import type { KnowledgeStore } from '../../storage/types.js';

const TWITTER_HOME = 'https://x.com/home';
const TWITTER_SITE = 'twitter';

/** Poll until interceptedRaw has at least one entry, or timeout. */
function waitForData(interceptedRaw: RawTweetData[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const interval = 200;
    let elapsed = 0;
    const check = () => {
      if (interceptedRaw.length > 0 || elapsed >= timeoutMs) {
        resolve();
        return;
      }
      elapsed += interval;
      setTimeout(check, interval);
    };
    check();
  });
}

export interface CheckLoginResult {
  loggedIn: boolean;
}

/**
 * Check if user is logged in to Twitter.
 * Does not throw on not-logged-in — returns { loggedIn: false }.
 */
export async function checkLogin(primitives: Primitives): Promise<CheckLoginResult> {
  await primitives.navigate(TWITTER_HOME, TWITTER_SITE);

  // Check URL for login redirect
  const currentUrl = await primitives.evaluate<string>(
    'window.location.href',
    TWITTER_SITE,
  );
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    return { loggedIn: false };
  }

  // Check accessibility tree for Home navigation link
  const snapshot = await primitives.takeSnapshot(TWITTER_SITE);
  const homeUid = matchByRule(snapshot, rules.homeNavLink);
  if (homeUid) {
    return { loggedIn: true };
  }

  return { loggedIn: false };
}

/** Auth guard. Throws SessionExpired if not logged in. */
export async function requireLogin(primitives: Primitives): Promise<void> {
  const { loggedIn } = await checkLogin(primitives);
  if (!loggedIn) {
    throw new SessionExpired('Twitter login required', {
      url: TWITTER_HOME,
      step: 'requireLogin',
    });
  }
}

/**
 * Collect timeline tweets.
 * Sets up GraphQL interception before navigation so the initial
 * page load response is captured. Scroll + collection is delegated
 * to collectTweetsFromTimeline.
 */
export type TimelineFeed = 'following' | 'for_you';

export interface GetFeedOptions {
  count?: number;
  tab?: TimelineFeed;
  debug?: boolean;
  store?: KnowledgeStore;
  dumpRaw?: string;
}

export async function getFeed(
  primitives: Primitives,
  opts: GetFeedOptions = {},
): Promise<FeedResult> {
  const { count = 20, tab = 'following', debug = false, store, dumpRaw } = opts;
  const startTime = Date.now();
  let graphqlResponseCount = 0;
  let reloadFallback = false;

  // Set up interception BEFORE navigation so initial GraphQL response is captured
  const interceptedRaw: RawTweetData[] = [];
  let dumpIndex = 0;
  const cleanup = await primitives.interceptRequest(
    GRAPHQL_TIMELINE_PATTERN,
    (response) => {
      try {
        if (dumpRaw) {
          fs.mkdirSync(dumpRaw, { recursive: true });
          const outPath = path.join(dumpRaw, `graphql-${dumpIndex++}.json`);
          fs.writeFileSync(outPath, response.body);
        }
        const parsed = parseGraphQLTimeline(response.body);
        interceptedRaw.push(...parsed);
        graphqlResponseCount++;
      } catch {
        // GraphQL parse failed — ignore this response
      }
    },
    TWITTER_SITE,
  );

  try {
    // Navigate to timeline — auth guard auto-checks login
    const ensure = makeEnsureState(primitives, TWITTER_SITE);
    const { action } = await ensure({ url: TWITTER_HOME });
    if (action === 'already_there') {
      // Already on home — intercept needs a fresh page load to capture GraphQL
      await primitives.navigate(TWITTER_HOME, TWITTER_SITE);
    }

    // Switch to the requested feed tab
    const tabName = tab === 'following' ? 'Following' : 'For you';
    const { action: tabAction } = await ensure({ role: 'tab', name: tabName, selected: true });
    if (tabAction !== 'already_there') {
      // Tab was switched — discard data from the previous tab and wait for
      // the new tab's GraphQL response to arrive
      interceptedRaw.length = 0;
      await waitForData(interceptedRaw, 3000);

      if (interceptedRaw.length === 0) {
        // Twitter used cached data — no GraphQL request fired.
        // Force a reload to get fresh data from the server.
        reloadFallback = true;
        await primitives.navigate(TWITTER_HOME, TWITTER_SITE);
        await ensure({ role: 'tab', name: tabName, selected: true });
      }
    }

    // Scroll to collect more tweets if needed
    const rawTweets = await collectTweetsFromTimeline(primitives, interceptedRaw, count);

    // Parse and filter
    const tweets = rawTweets
      .map(parseTweet)
      .filter((t) => !t.isAd)
      .slice(0, count);

    const meta = buildFeedMeta(tweets);

    const result: FeedResult = { tweets, meta };
    if (debug) {
      result.debug = {
        tabRequested: tab,
        navAction: action,
        tabAction,
        reloadFallback,
        graphqlResponseCount,
        rawBeforeFilter: rawTweets.length,
        elapsedMs: Date.now() - startTime,
      };
    }
    // Persist to knowledge store — best-effort, never breaks the main flow
    if (store) {
      try {
        const ingestItems = tweetsToIngestItems(tweets);
        await store.ingest(ingestItems);
      } catch (err) {
        console.warn('Knowledge store ingest failed:', err);
      }
    }

    return result;
  } finally {
    cleanup();
  }
}
