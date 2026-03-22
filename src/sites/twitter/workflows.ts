import type { Primitives } from '../../primitives/types.js';
import { SessionExpired } from '../../errors.js';
import { matchByRule, rules } from './matchers.js';
import {
  collectTweetsFromTimeline,
  parseGraphQLTimeline,
  parseTweet,
  buildTimelineMeta,
  GRAPHQL_TIMELINE_PATTERN,
} from './extractors.js';
import type { RawTweetData, TimelineResult } from './types.js';

const TWITTER_HOME = 'https://x.com/home';
const TWITTER_SITE = 'twitter';

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
export async function getTimeline(
  primitives: Primitives,
  count: number = 20,
): Promise<TimelineResult> {
  // Set up interception BEFORE navigation so initial GraphQL response is captured
  const interceptedRaw: RawTweetData[] = [];
  const cleanup = await primitives.interceptRequest(
    GRAPHQL_TIMELINE_PATTERN,
    (response) => {
      try {
        const parsed = parseGraphQLTimeline(response.body);
        interceptedRaw.push(...parsed);
      } catch {
        // GraphQL parse failed — ignore this response
      }
    },
    TWITTER_SITE,
  );

  try {
    // Navigate to timeline — auth guard auto-checks login
    await primitives.navigate(TWITTER_HOME, TWITTER_SITE);

    // Scroll to collect more tweets if needed
    const rawTweets = await collectTweetsFromTimeline(primitives, interceptedRaw, count);

    // Parse and filter
    const tweets = rawTweets
      .map(parseTweet)
      .filter((t) => !t.isAd)
      .slice(0, count);

    const meta = buildTimelineMeta(tweets);

    return { tweets, meta };
  } finally {
    cleanup();
  }
}
