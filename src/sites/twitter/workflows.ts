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
  parseGraphQLSearch,
  GRAPHQL_TIMELINE_PATTERN,
  GRAPHQL_TWEET_DETAIL_PATTERN,
  GRAPHQL_SEARCH_PATTERN,
} from './extractors.js';
import { SiteUseError, StateTransitionFailed } from '../../errors.js';
import type { RawTweetData, SearchTab } from './types.js';
import type { FeedResult as FrameworkFeedResult } from '../../registry/types.js';
import { tweetToFeedItem } from './feed-item.js';
import { NOOP_TRACE, NOOP_SPAN, type Trace, type SpanHandle } from '../../trace.js';
import { ensurePage, type WaitRecord } from './ensure-page.js';

// Re-export WaitRecord so existing imports from workflows.ts don't break
export type { WaitRecord } from './ensure-page.js';

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
 * Check if browser was redirected to Twitter login page.
 * Twitter-specific: detects /login and /i/flow/login URL patterns.
 */
async function checkLoginRedirect(
  primitives: Primitives,
  span: SpanHandle = NOOP_SPAN,
): Promise<void> {
  await span.span('checkLogin', async (s) => {
    const url = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', url);
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', {
        retryable: false,
      });
    }
  });
}

/**
 * Collect timeline tweets.
 * Sets up GraphQL interception before navigation so the initial
 * page load response is captured. Scroll + collection is delegated
 * to collectData.
 */
export type TimelineFeed = 'following' | 'for_you';

const TAB_INDICES: Record<TimelineFeed, number> = {
  for_you: 0,
  following: 1,
};

const TAB_SELECTOR = '[data-testid="primaryColumn"] [role="tablist"] [role="tab"]';
const TAB_POLL_INTERVAL_MS = 500;
const TAB_POLL_TIMEOUT_MS = 5000;

/**
 * Ensure the given tab is selected on the Twitter home timeline.
 * Uses CSS selector + position index (locale-agnostic) instead of ARIA name matching.
 * index 0 = For you, index 1 = Following — consistent across all locales.
 */
export async function ensureTab(
  primitives: Primitives,
  tab: TimelineFeed,
): Promise<'already_there' | 'transitioned'> {
  const index = TAB_INDICES[tab];

  const isSelected = await primitives.evaluate<boolean>(`(() => {
    const tabs = document.querySelectorAll('${TAB_SELECTOR}');
    return tabs[${index}]?.getAttribute('aria-selected') === 'true';
  })()`);

  if (isSelected) return 'already_there';

  await primitives.evaluate(`(() => {
    const tabs = document.querySelectorAll('${TAB_SELECTOR}');
    tabs[${index}]?.click();
  })()`);

  const deadline = Date.now() + TAB_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, TAB_POLL_INTERVAL_MS));
    const confirmed = await primitives.evaluate<boolean>(`(() => {
      const tabs = document.querySelectorAll('${TAB_SELECTOR}');
      return tabs[${index}]?.getAttribute('aria-selected') === 'true';
    })()`);
    if (confirmed) return 'transitioned';
  }

  throw new StateTransitionFailed(
    `Tab switch to index ${index} not confirmed after ${TAB_POLL_TIMEOUT_MS}ms`,
    { step: `ensureTab: waiting for tab ${index} to become selected` },
  );
}

export interface GetFeedOptions {
  count?: number;
  tab?: TimelineFeed;
  dumpRaw?: string;
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
  const ensure = makeEnsureState(primitives);
  let navAction: 'already_there' | 'transitioned' = 'already_there';
  let tabAction: 'already_there' | 'transitioned' = 'already_there';

  const result = await ensurePage(primitives, {
    collector,
    t0,
    label: `timeline/${tab}`,
    navigate: async (p) => {
      const navResult = await ensure({ url: TWITTER_HOME });
      navAction = navResult.action;
      if (navResult.action === 'already_there') {
        await p.navigate(TWITTER_HOME);
      }
    },
    afterNavigate: async (_p, s) => {
      const prevLength = collector.length;
      tabAction = await ensureTab(primitives, tab);
      s.set('tabAction', tabAction);
      s.set('tab', tab);
      if (tabAction !== 'already_there') {
        const dataFromSwitch = collector.items.slice(prevLength);
        collector.clear();
        if (dataFromSwitch.length > 0) {
          collector.push(...dataFromSwitch);
        }
      }
    },
    afterReload: async () => {
      await ensureTab(primitives, tab);
    },
  }, span);

  return { navAction, tabAction, ...result };
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
  return ensurePage(primitives, {
    collector,
    t0: opts.t0,
    label: 'tweet-detail',
    navigate: (p) => p.navigate(opts.url),
    afterNavigate: (p, s) => checkLoginRedirect(p, s),
  }, span);
}

export interface EnsureSearchResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

/**
 * Navigate to Twitter search page and wait for GraphQL data.
 * Builds the search URL from query and tab, then waits for SearchTimeline response.
 */
export async function ensureSearch(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { query: string; tab: SearchTab; t0: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsureSearchResult> {
  const tabParam = opts.tab === 'latest' ? '&f=live' : '';
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(opts.query)}&src=typed_query${tabParam}`;

  return ensurePage(primitives, {
    collector,
    t0: opts.t0,
    label: `search/${opts.query}`,
    navigate: (p) => p.navigate(searchUrl),
    afterNavigate: (p, s) => checkLoginRedirect(p, s),
  }, span);
}

export interface GetSearchOptions {
  query: string;
  tab?: SearchTab;
  count?: number;
  dumpRaw?: string;
}

/**
 * Search Twitter and collect results.
 * Sets up GraphQL interception, navigates to search page,
 * scrolls to collect results, returns as FeedResult.
 */
export async function getSearch(
  primitives: Primitives,
  opts: GetSearchOptions,
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
  const { query, tab = 'top', count = 20, dumpRaw } = opts;
  const t0 = Date.now();

  return await trace.span('getSearch', async (rootSpan) => {
    rootSpan.set('query', query);
    rootSpan.set('tab', tab);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

    const collector = createDataCollector<RawTweetData>();
    let dumpIndex = 0;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_SEARCH_PATTERN,
      (response) => {
        try {
          if (dumpRaw) {
            fs.mkdirSync(dumpRaw, { recursive: true });
            const outPath = path.join(dumpRaw, `search-${dumpIndex++}.json`);
            fs.writeFileSync(outPath, response.body);
          }
          const parsed = parseGraphQLSearch(response.body);
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
      await rootSpan.span('ensureSearch', async (s) => {
        await ensureSearch(primitives, collector, { query, tab, t0 }, s);
      });

      if (collector.length < count) {
        await rootSpan.span('collectData', async (s) => {
          await collectData(primitives, collector, { count, t0 }, s);
        });
      }

      const tweets = [...collector.items]
        .map(parseTweet)
        .filter((t) => !t.isAd)
        .slice(0, count);

      if (tweets.length === 0) {
        console.error(`[site-use] no tweets found for "${query}"`);
      }

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
