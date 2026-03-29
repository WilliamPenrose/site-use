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
import { NOOP_TRACE, NOOP_SPAN, type Trace, type SpanHandle } from '../../trace.js';

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
  span: SpanHandle = NOOP_SPAN,
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
  console.error('[site-use] navigating to timeline...');
  const { action: navAction } = await span.span('navigate', async (s) => {
    const result = await ensure({ url: TWITTER_HOME });
    s.set('action', result.action);
    if (result.action === 'already_there') {
      await primitives.navigate(TWITTER_HOME);
    }
    return result;
  });

  // Step 2: Switch to target tab
  const tabName = tab === 'following' ? 'Following' : 'For you';
  console.error(`[site-use] switching to "${tabName}" tab...`);
  const prevLength = collector.length;
  const { action: tabAction } = await span.span('switchTab', async (s) => {
    const result = await ensure({ role: 'tab', name: tabName, selected: true });
    s.set('action', result.action);
    s.set('tabName', tabName);
    if (result.action !== 'already_there') {
      const dataFromSwitch = collector.items.slice(prevLength);
      collector.clear();
      if (dataFromSwitch.length > 0) {
        collector.push(...dataFromSwitch);
      }
    }
    return result;
  });

  // Step 3: Wait for data
  console.error('[site-use] waiting for timeline data...');
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData && !reloaded) {
      console.error('[site-use] no data yet, reloading page...');
      reloaded = true;
      collector.clear();
      await primitives.navigate(TWITTER_HOME);
      await ensure({ role: 'tab', name: tabName, selected: true });
      const hasDataAfterReload = await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', hasDataAfterReload);
      s.set('dataCountAfterReload', collector.length);
    }
  });

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
  span: SpanHandle = NOOP_SPAN,
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
  console.error('[site-use] navigating to tweet...');
  await span.span('navigate', async () => {
    await primitives.navigate(url);
  });

  // Step 2: Check for login redirect
  await span.span('checkLogin', async (s) => {
    const currentUrl = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', currentUrl);
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', { retryable: false });
    }
  });

  // Step 3: Wait for initial data
  console.error('[site-use] waiting for tweet data...');
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData) {
      console.error('[site-use] no data yet, reloading page...');
      reloaded = true;
      collector.clear();
      await primitives.navigate(url);
      const hasDataAfterReload = await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', hasDataAfterReload);
      s.set('dataCountAfterReload', collector.length);
    }
  });

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
  span: SpanHandle = NOOP_SPAN,
): Promise<CollectDataResult> {
  const { count, t0 } = opts;
  const waits: Array<WaitRecord & { round: number }> = [];

  // Fast path: already have enough data
  if (collector.length >= count) {
    console.error(`[site-use] already have ${collector.length}/${count} items, skipping scroll`);
    return { scrollRounds: 0, waits };
  }

  console.error(`[site-use] scrolling to collect ${count} items...`);
  let staleRounds = 0;
  let round = 0;

  while (staleRounds < MAX_STALE_ROUNDS) {
    if (collector.length >= count) break;

    round++;
    const prevTotal = collector.length;

    await span.span(`scroll_${round}`, async (s) => {
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

      s.set('satisfied', satisfied);
      s.set('dataCount', collector.length);
      s.set('newItems', collector.length - prevTotal);

      if (satisfied) {
        staleRounds = 0;
        console.error(`[site-use] scroll ${round}: collected ${collector.length}/${count} items`);
      } else {
        staleRounds++;
        console.error(`[site-use] scroll ${round}: no new data (stale ${staleRounds}/${MAX_STALE_ROUNDS})`);
      }
    });
  }

  return { scrollRounds: round, waits };
}

export async function getFeed(
  primitives: Primitives,
  opts: GetFeedOptions = {},
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
  const { count = 20, tab = 'for_you', dumpRaw } = opts;

  const t0 = Date.now();

  return await trace.span('getFeed', async (rootSpan) => {
    rootSpan.set('tab', tab);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

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
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch {
          graphqlFailures++;
          rootSpan.set('graphqlFailures', graphqlFailures);
        }
      },
    );

    try {
      await rootSpan.span('ensureTimeline', async (s) => {
        await ensureTimeline(primitives, collector, { tab, t0 }, s);
      });

      await rootSpan.span('collectData', async (s) => {
        await collectData(primitives, collector, { count, t0 }, s);
      });

      const tweets = [...collector.items]
        .map(parseTweet)
        .filter((t) => !t.isAd)
        .slice(0, count);

      const meta = buildFeedMeta(tweets);
      const items = tweets.map(tweetToFeedItem);

      rootSpan.set('rawBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);

      return {
        items,
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      cleanup();
    }
  });
}

export interface GetTweetDetailOptions {
  url: string;
  count?: number;
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
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
  const { url, count = 20, dumpRaw } = opts;
  const t0 = Date.now();

  return await trace.span('getTweetDetail', async (rootSpan) => {
    rootSpan.set('url', url);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

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
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch {
          graphqlFailures++;
          rootSpan.set('graphqlFailures', graphqlFailures);
        }
      },
    );

    try {
      await rootSpan.span('ensureTweetDetail', async (s) => {
        await ensureTweetDetail(primitives, collector, { url, t0 }, s);
      });

      if (collector.length < count && hasCursor) {
        await rootSpan.span('collectData', async (s) => {
          await collectData(primitives, collector, { count, t0 }, s);
        });
      }

      const allRaw = anchor ? [anchor, ...collector.items] : [...collector.items];
      const tweets = allRaw
        .map(parseTweet)
        .filter((t) => !t.isAd);

      const anchorTweet = anchor ? tweets[0] : undefined;
      const replyTweets = anchor ? tweets.slice(1, count + 1) : tweets.slice(0, count);
      const finalTweets = anchorTweet ? [anchorTweet, ...replyTweets] : replyTweets;

      const meta = buildFeedMeta(finalTweets);
      const items = finalTweets.map(tweetToFeedItem);

      rootSpan.set('rawRepliesBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);
      rootSpan.set('hasAnchor', anchor !== null);

      return {
        items,
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      cleanup();
    }
  });
}
