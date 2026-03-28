import fs from 'node:fs';
import path from 'node:path';
import type { Primitives } from '../../primitives/types.js';
import { isLoggedIn } from './site.js';
import { makeEnsureState } from '../../ops/ensure-state.js';
import { createDataCollector, type DataCollector } from '../../ops/data-collector.js';
import {
  parseGraphQLTimeline,
  parseTweet,
  buildFeedMeta,
  parseTweetDetail,
  GRAPHQL_TIMELINE_PATTERN,
  GRAPHQL_TWEET_DETAIL_PATTERN,
} from './extractors.js';
import { SiteUseError } from '../../errors.js';
import type { RawTweetData } from './types.js';
import type { FeedResult as FrameworkFeedResult } from '../../registry/types.js';
import { tweetToFeedItem } from './feed-item.js';

const TWITTER_HOME = 'https://x.com/home';

export interface CheckLoginResult {
  loggedIn: boolean;
}

/**
 * Check if user is logged in to Twitter.
 * Does not throw on not-logged-in — returns { loggedIn: false }.
 */
export async function checkLogin(primitives: Primitives): Promise<CheckLoginResult> {
  await primitives.navigate(TWITTER_HOME);
  const { loggedIn } = await isLoggedIn(primitives);
  return { loggedIn };
}

/**
 * Collect timeline tweets.
 * Sets up GraphQL interception before navigation so the initial
 * page load response is captured. Scroll + collection is delegated
 * to collectData.
 */
export type TimelineFeed = 'following' | 'for_you';

export interface GetFeedOptions {
  count?: number;
  tab?: TimelineFeed;
  debug?: boolean;
  dumpRaw?: string;
}

export interface WaitRecord {
  purpose: string;
  startedAt: number;
  resolvedAt: number;
  satisfied: boolean;
  dataCount: number;
}

export interface EnsureTimelineResult {
  navAction: 'already_there' | 'transitioned';
  tabAction: 'already_there' | 'transitioned';
  reloaded: boolean;
  waits: WaitRecord[];
}

export interface CollectDataResult {
  scrollRounds: number;
  waits: Array<WaitRecord & { round: number }>;
}

const WAIT_FOR_DATA_MS = 3000;

/**
 * Ensure browser is on Twitter home with the target tab selected
 * and the DataCollector has received GraphQL data for that tab.
 */
export async function ensureTimeline(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { tab: TimelineFeed; t0: number },
): Promise<EnsureTimelineResult> {
  const { tab, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  // Helper to record a timed waitUntil call
  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  const ensure = makeEnsureState(primitives);

  // Step 1: Navigate to Twitter home
  const { action: navAction } = await ensure({ url: TWITTER_HOME });
  if (navAction === 'already_there') {
    // Already on home — force reload to trigger GraphQL
    await primitives.navigate(TWITTER_HOME);
  }

  // Step 2: Switch to target tab
  // Clear before the ensure call so data from the old tab is discarded,
  // but data arriving from the tab-switch click is preserved.
  const tabName = tab === 'following' ? 'Following' : 'For you';
  const prevLength = collector.length;
  const { action: tabAction } = await ensure({ role: 'tab', name: tabName, selected: true });
  if (tabAction !== 'already_there') {
    // Tab was switched — discard any data that was present before the switch.
    // Data pushed during the ensure call (from the click) is kept.
    const dataFromSwitch = collector.items.slice(prevLength);
    collector.clear();
    if (dataFromSwitch.length > 0) {
      collector.push(...dataFromSwitch);
    }
  }

  // Step 3: Wait for data
  const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);

  if (!hasData && !reloaded) {
    // No data — Twitter may have used cache. Reload fallback.
    reloaded = true;
    collector.clear();
    await primitives.navigate(TWITTER_HOME);
    await ensure({ role: 'tab', name: tabName, selected: true });
    await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
    // If still no data after reload, proceed anyway — collectData scrolling may trigger GraphQL
  }

  return { navAction, tabAction, reloaded, waits };
}

export interface EnsureTweetDetailResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

/**
 * Navigate to tweet detail page and wait for GraphQL data.
 * Checks for login redirect. Falls back to reload if no data arrives.
 */
export async function ensureTweetDetail(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { url: string; t0: number },
): Promise<EnsureTweetDetailResult> {
  const { url, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  // Step 1: Navigate to tweet detail page
  await primitives.navigate(url);

  // Step 2: Check for login redirect
  const currentUrl = await primitives.evaluate<string>('window.location.href');
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', { retryable: false });
  }

  // Step 3: Wait for initial data
  const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);

  // Step 4: Fallback — reload if no data
  if (!hasData) {
    reloaded = true;
    collector.clear();
    await primitives.navigate(url);
    await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
  }

  return { reloaded, waits };
}

const MAX_STALE_ROUNDS = 3;
const SCROLL_WAIT_MS = 2000;

/**
 * Scroll timeline and collect data until count is reached or no more data arrives.
 */
export async function collectData(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { count: number; t0: number },
): Promise<CollectDataResult> {
  const { count, t0 } = opts;
  const waits: Array<WaitRecord & { round: number }> = [];

  // Fast path: already have enough data
  if (collector.length >= count) {
    return { scrollRounds: 0, waits };
  }

  let staleRounds = 0;
  let round = 0;

  while (staleRounds < MAX_STALE_ROUNDS) {
    if (collector.length >= count) break;

    round++;
    const prevTotal = collector.length;
    await primitives.scroll({ direction: 'down' });

    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(() => collector.length > prevTotal, SCROLL_WAIT_MS);
    waits.push({
      round,
      purpose: `scroll_${round}`,
      startedAt,
      resolvedAt: Date.now() - t0,
      satisfied,
      dataCount: collector.length,
    });

    if (satisfied) {
      staleRounds = 0;
    } else {
      staleRounds++;
    }
  }

  return { scrollRounds: round, waits };
}

export async function getFeed(
  primitives: Primitives,
  opts: GetFeedOptions = {},
): Promise<FrameworkFeedResult> {
  const { count = 20, tab = 'for_you', debug = false, dumpRaw } = opts;
  const t0 = Date.now();
  let graphqlResponseCount = 0;
  let graphqlParseFailures = 0;
  const notifyTimestamps: number[] = [];

  const collector = createDataCollector<RawTweetData>();
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
        collector.push(...parsed);
        graphqlResponseCount++;
        notifyTimestamps.push(Date.now() - t0);
      } catch {
        graphqlParseFailures++;
      }
    },
  );

  try {
    const timelineResult = await ensureTimeline(primitives, collector, { tab, t0 });
    const collectResult = await collectData(primitives, collector, { count, t0 });

    const tweets = [...collector.items]
      .map(parseTweet)
      .filter((t) => !t.isAd)
      .slice(0, count);

    const meta = buildFeedMeta(tweets);
    const items = tweets.map(tweetToFeedItem);

    const frameworkResult: FrameworkFeedResult = {
      items,
      meta: {
        coveredUsers: meta.coveredUsers,
        timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
      },
    };

    if (debug) {
      frameworkResult.debug = {
        tabRequested: tab,
        graphqlResponseCount,
        graphqlParseFailures,
        notifyTimestamps,
        rawBeforeFilter: collector.length,
        elapsedMs: Date.now() - t0,
        ensureTimeline: timelineResult,
        collectData: collectResult,
      };
    }

    return frameworkResult;
  } finally {
    cleanup();
  }
}

export interface GetTweetDetailOptions {
  url: string;
  count?: number;
  debug?: boolean;
  dumpRaw?: string;
}

/**
 * Fetch a tweet and its replies.
 * Sets up GraphQL interception, navigates to the tweet detail page,
 * collects replies via scroll, and returns anchor + replies as FeedResult.
 */
export async function getTweetDetail(
  primitives: Primitives,
  opts: GetTweetDetailOptions,
): Promise<FrameworkFeedResult> {
  const { url, count = 20, debug = false, dumpRaw } = opts;
  const t0 = Date.now();
  let graphqlResponseCount = 0;
  let graphqlParseFailures = 0;

  // Anchor is stored separately; only replies go into collector.
  let anchor: RawTweetData | null = null;
  let hasCursor = false;
  const collector = createDataCollector<RawTweetData>();
  let dumpIndex = 0;

  const cleanup = await primitives.interceptRequest(
    GRAPHQL_TWEET_DETAIL_PATTERN,
    (response) => {
      try {
        if (dumpRaw) {
          fs.mkdirSync(dumpRaw, { recursive: true });
          const outPath = path.join(dumpRaw, `tweet-detail-${dumpIndex++}.json`);
          fs.writeFileSync(outPath, response.body);
        }
        const parsed = parseTweetDetail(response.body);
        if (parsed.anchor && !anchor) {
          anchor = parsed.anchor;
        }
        hasCursor = parsed.hasCursor;
        if (parsed.replies.length > 0) {
          collector.push(...parsed.replies);
        }
        graphqlResponseCount++;
      } catch {
        graphqlParseFailures++;
      }
    },
  );

  try {
    const ensureResult = await ensureTweetDetail(primitives, collector, { url, t0 });

    // Only scroll for more if we need more replies AND there are more to load
    let collectResult: CollectDataResult = { scrollRounds: 0, waits: [] };
    if (collector.length < count && hasCursor) {
      collectResult = await collectData(primitives, collector, { count, t0 });
    }

    // Build items: anchor first, then replies
    const allRaw = anchor ? [anchor, ...collector.items] : [...collector.items];
    const tweets = allRaw
      .map(parseTweet)
      .filter((t) => !t.isAd);

    // Trim replies to count (anchor doesn't count toward limit)
    const anchorTweet = anchor ? tweets[0] : undefined;
    const replyTweets = anchor ? tweets.slice(1, count + 1) : tweets.slice(0, count);
    const finalTweets = anchorTweet ? [anchorTweet, ...replyTweets] : replyTweets;

    const meta = buildFeedMeta(finalTweets);
    const items = finalTweets.map(tweetToFeedItem);

    const frameworkResult: FrameworkFeedResult = {
      items,
      meta: {
        coveredUsers: meta.coveredUsers,
        timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
      },
    };

    if (debug) {
      frameworkResult.debug = {
        graphqlResponseCount,
        graphqlParseFailures,
        rawRepliesBeforeFilter: collector.length,
        elapsedMs: Date.now() - t0,
        ensureTweetDetail: ensureResult,
        collectData: collectResult,
      };
    }

    return frameworkResult;
  } finally {
    cleanup();
  }
}
