import fs from 'node:fs';
import path from 'node:path';
import type { Primitives, SnapshotNode } from '../../primitives/types.js';
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
import { StateTransitionFailed, ElementNotFound } from '../../errors.js';
import { resolveHandle, checkLoginRedirect, checkProfileError } from './navigate.js';
import type { RawTweetData, SearchTab } from './types.js';
import { TwitterFeedParamsSchema } from './types.js';
import { z } from 'zod';
import { findByDescriptor } from '../../ops/matchers.js';
import type { FollowResult, FollowState } from './types.js';
import { TwitterFollowActionParamsSchema } from './types.js';
import { ensureTab as ensureTabNav, discoverTabs } from '../../ops/tab-navigator.js';

type FeedParams = z.infer<typeof TwitterFeedParamsSchema>;
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
 * Collect timeline tweets.
 * Sets up GraphQL interception before navigation so the initial
 * page load response is captured. Scroll + collection is delegated
 * to collectData.
 */
const TAB_SELECTOR = '[data-testid="primaryColumn"] [role="tablist"] [role="tab"]';
const WELL_KNOWN_TABS: Record<string, number> = { for_you: 0, following: 1 };

function isWellKnownTab(tab: string): boolean {
  const normalized = tab.normalize('NFC').toLowerCase().replace(/_/g, ' ').trim().replace(/ /g, '_');
  return normalized in WELL_KNOWN_TABS;
}

/**
 * Re-discover tabs after data collection, polling until the count stabilizes
 * (two consecutive reads return the same set). Pinned List/Community tabs
 * render later than the default For you / Following tabs.
 *
 * Best-effort: returns fallback on timeout or error.
 */
async function discoverStableTabs(
  primitives: Primitives,
  fallback: string[],
): Promise<string[]> {
  let prev: string[] | null = null;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const fresh = await discoverTabs(primitives, TAB_SELECTOR, { timeoutMs: 2000 });
      const names = fresh.map(t => t.name);
      if (prev !== null && names.length === prev.length && names.every((n, j) => n === prev![j])) return names;
      prev = names;
    } catch { return prev ?? fallback; }
  }
  return prev ?? fallback;
}


export interface EnsureTimelineResult {
  navAction: 'already_there' | 'transitioned';
  tabAction: 'already_there' | 'transitioned';
  availableTabs: string[];
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
  opts: {
    tab: string;
    t0: number;
    reRegisterInterceptor: () => Promise<void>;
  },
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsureTimelineResult> {
  const { tab, t0, reRegisterInterceptor } = opts;
  const ensure = makeEnsureState(primitives);
  let navAction: 'already_there' | 'transitioned' = 'already_there';
  let tabAction: 'already_there' | 'transitioned' = 'already_there';
  let availableTabs: string[] = [];

  async function switchTab(s?: SpanHandle) {
    await reRegisterInterceptor();
    const tabResult = await ensureTabNav(primitives, tab, TAB_SELECTOR, WELL_KNOWN_TABS);
    tabAction = tabResult.action;
    availableTabs = tabResult.availableTabs;
    if (s) {
      s.set('tabAction', tabAction);
      s.set('tab', tab);
    }
  }

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
      await switchTab(s);
    },
    afterReload: async () => {
      await switchTab();
    },
  }, span);

  return { navAction, tabAction, availableTabs, ...result };
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

    const intercept = await primitives.interceptRequestWithControl(
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
          await collectData(primitives, collector, {
            count, t0,
            hasInflightRequest: intercept.hasPending,
          }, s);
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
      intercept.cleanup();
    }
  });
}

const MAX_STALE_ROUNDS = 3;
const MAX_PHASE1_SCROLLS = 20;
const MAX_FAILED_ROUNDS = 3;
const SCROLL_WAIT_MS = 2000;
const PHASE1_PAUSE_MIN_MS = 50;
const PHASE1_PAUSE_MAX_MS = 150;
const BOTTOM_WAIT_MS = 500;

/**
 * Scroll timeline and collect data until count is reached or no more data arrives.
 *
 * Two-phase design:
 * - Phase 1: fast scroll until a matching API request fires or page bottom reached
 * - Phase 2: request is in-flight, wait for response data to arrive in collector
 */
export async function collectData(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { count: number; t0: number; hasInflightRequest: () => boolean },
  span: SpanHandle = NOOP_SPAN,
): Promise<CollectDataResult> {
  const { count, t0, hasInflightRequest } = opts;

  // Fast path: already have enough data
  if (collector.length >= count) {
    console.error(`[site-use] already have ${collector.length}/${count} items, skipping scroll`);
    return { scrollRounds: 0, waits: [] };
  }

  console.error(`[site-use] scrolling to collect ${count} items...`);
  let staleRounds = 0;
  let failedRounds = 0;
  let forceScroll = false;
  let totalScrolls = 0;

  const checkAtBottom = () =>
    primitives.evaluate<boolean>(
      `window.scrollY + document.documentElement.clientHeight >= document.documentElement.scrollHeight - 200`,
    );

  while (collector.length < count) {
    const prevTotal = collector.length;

    // Phase 1: fast scroll until request fires or at bottom
    let phase1Scrolls = 0;
    await span.span(`phase1_${totalScrolls}`, async (s) => {
      while (phase1Scrolls < MAX_PHASE1_SCROLLS) {
        const atBottom = await checkAtBottom();
        if (atBottom) {
          s.set('exitReason', 'atBottom');
          break;
        }
        if (!forceScroll && hasInflightRequest()) {
          s.set('exitReason', 'requestFired');
          break;
        }
        forceScroll = false;

        await primitives.scroll({ direction: 'down', amount: 1200 });
        phase1Scrolls++;
        totalScrolls++;

        const pause = PHASE1_PAUSE_MIN_MS + Math.random() * (PHASE1_PAUSE_MAX_MS - PHASE1_PAUSE_MIN_MS);
        await new Promise((r) => setTimeout(r, pause));
      }
      if (phase1Scrolls >= MAX_PHASE1_SCROLLS) {
        s.set('exitReason', 'maxScrolls');
      }
      s.set('scrolls', phase1Scrolls);
    });
    forceScroll = false;

    // Stale check: at bottom with no pending request
    const atBottom = await checkAtBottom();
    if (atBottom && !hasInflightRequest()) {
      await new Promise((r) => setTimeout(r, BOTTOM_WAIT_MS));
      if (hasInflightRequest()) {
        console.error(`[site-use] request fired during bottom wait, continuing`);
        continue;
      }
      staleRounds++;
      console.error(`[site-use] at bottom, no request (stale ${staleRounds}/${MAX_STALE_ROUNDS})`);
      if (staleRounds >= MAX_STALE_ROUNDS) break;
      continue;
    }

    // Phase 2: request is out, wait for data
    staleRounds = 0;
    const satisfied = await span.span(`phase2_${totalScrolls}`, async (s) => {
      const startedAt = Date.now() - t0;
      const ok = await collector.waitUntil(() => collector.length > prevTotal, SCROLL_WAIT_MS);
      s.set('satisfied', ok);
      s.set('startedAt', startedAt);
      s.set('resolvedAt', Date.now() - t0);
      s.set('dataCount', collector.length);
      s.set('newItems', collector.length - prevTotal);
      return ok;
    });

    if (satisfied) {
      failedRounds = 0;
      console.error(`[site-use] collected ${collector.length}/${count} items`);
    } else {
      failedRounds++;
      forceScroll = true;
      console.error(`[site-use] phase2 timeout (failed ${failedRounds}/${MAX_FAILED_ROUNDS})`);
      if (failedRounds >= MAX_FAILED_ROUNDS) break;
    }
  }

  return { scrollRounds: totalScrolls, waits: [] };
}

export async function getFeed(
  primitives: Primitives,
  opts: FeedParams & { dumpRaw?: string },
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

    const handler = (response: { url: string; status: number; body: string }) => {
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
    };

    // Single listener with request-level tracking. reset() invalidates all
    // in-flight requests so stale responses (e.g. navigate(home)'s HomeTimeline)
    // are silently discarded after a tab switch. Fixes issue #18.
    const intercept = await primitives.interceptRequestWithControl(
      GRAPHQL_TIMELINE_PATTERN, handler,
    );

    const reRegisterInterceptor = async () => {
      // navigate(home) loads the default tab (for_you). When that IS the target,
      // the navigate data is correct — clearing + resetting would discard it
      // with no new request to replenish. For any other tab, we must clear stale
      // data and reset request tracking so only R2 (the target tab's response)
      // is accepted.
      const normalizedTab = tab.normalize('NFC').toLowerCase().replace(/_/g, ' ').trim().replace(/ /g, '_');
      if (WELL_KNOWN_TABS[normalizedTab] === 0) return;
      collector.clear();
      intercept.reset();
    };

    try {
      const timelineResult = await rootSpan.span('ensureTimeline', async (s) => {
        return await ensureTimeline(primitives, collector, { tab, t0, reRegisterInterceptor }, s);
      });

      await rootSpan.span('collectData', async (s) => {
        await collectData(primitives, collector, {
          count, t0,
          hasInflightRequest: intercept.hasPending,
        }, s);
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
          extra: {
            availableTabs: isWellKnownTab(tab)
              ? await discoverStableTabs(primitives, timelineResult.availableTabs)
              : timelineResult.availableTabs,
          },
        },
      };
    } finally {
      intercept.cleanup();
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
    let ancestors: RawTweetData[] = [];
    let hasCursor = false;
    const collector = createDataCollector<RawTweetData>();
    let dumpIndex = 0;

    const intercept = await primitives.interceptRequestWithControl(
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
            ancestors = parsed.ancestors;
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
          await collectData(primitives, collector, {
            count, t0,
            hasInflightRequest: intercept.hasPending,
          }, s);
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

      const ancestorItems = ancestors
        .map(parseTweet)
        .filter((t) => !t.isAd)
        .map(tweetToFeedItem);

      rootSpan.set('rawRepliesBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);
      rootSpan.set('hasAnchor', anchor !== null);
      rootSpan.set('ancestorCount', ancestorItems.length);

      return {
        items,
        ...(ancestorItems.length > 0 && { ancestors: ancestorItems }),
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      intercept.cleanup();
    }
  });
}

// ── Follow / Unfollow ────────────────────────────────────────────

const FOLLOW_POLL_INTERVAL_MS = 500;
const FOLLOW_POLL_TIMEOUT_MS = 10_000;

/**
 * DOM query result for the follow button found via data-testid.
 * Twitter uses three testid suffixes (verified 2026-04-03):
 *   - "{userId}-follow"   → not following
 *   - "{userId}-unfollow" → following
 *   - "{userId}-cancel"   → pending (follow request sent to protected account)
 */
interface FollowButtonDomInfo {
  state: FollowState;
  ariaLabel: string;
}

/**
 * Detect follow state via DOM-to-ARIA bridge pattern (locale-agnostic).
 *
 * Phase 1 (DOM): data-testid determines state unambiguously:
 *   - "-unfollow" → following
 *   - "-follow"   → not_following
 *   - "-cancel"   → pending
 *
 * Phase 2 (ARIA): Match ariaLabel in snapshot to get clickable uid.
 *   For pending ("-cancel"), ariaLabel is null — fall back to button text matching.
 */
async function detectFollowButton(
  primitives: Primitives,
  snapshot: { idToNode: Map<string, SnapshotNode> },
  handle: string,
): Promise<{ state: FollowState; node: SnapshotNode } | null> {
  // Phase 1: DOM query via data-testid (locale-agnostic)
  const domInfo = await primitives.evaluate<FollowButtonDomInfo | null>(`(() => {
    const handle = ${JSON.stringify(handle)};
    const allBtns = document.querySelectorAll(
      'button[data-testid$="-unfollow"], button[data-testid$="-follow"], button[data-testid$="-cancel"]'
    );
    for (const btn of allBtns) {
      const testid = btn.getAttribute('data-testid') || '';
      const ariaLabel = btn.getAttribute('aria-label') || '';
      // -cancel has no ariaLabel, so we can't verify by @handle like -follow/-unfollow.
      // This is safe because: we navigate to x.com/{handle} first, and a profile page
      // only has one -cancel button (the profile owner's). Sidebar recommendations show
      // -follow buttons, not -cancel (you can't be pending on a recommended user).
      if (testid.endsWith('-cancel')) {
        const text = btn.textContent?.trim() || '';
        return { state: 'pending', ariaLabel: text };
      }
      if (!ariaLabel.includes('@' + handle)) continue;
      if (testid.endsWith('-unfollow')) {
        return { state: 'following', ariaLabel };
      }
      if (testid.endsWith('-follow')) {
        return { state: 'not_following', ariaLabel };
      }
    }
    return null;
  })()`);

  if (!domInfo) return null;

  // Phase 2: Match in ARIA snapshot to get clickable uid.
  // For -follow/-unfollow, ariaLabel is the real aria-label (e.g. "フォロー @handle").
  // For -cancel, ariaLabel is the button's textContent (e.g. "未承認") since aria-label is null.
  // If ariaLabel is empty (no textContent), we can't match — return null and let poll retry.
  if (!domInfo.ariaLabel) return null;

  const escaped = domInfo.ariaLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const node = findByDescriptor(snapshot, { role: 'button', name: new RegExp(escaped, 'i') });
  if (node) return { state: domInfo.state, node };

  return null;
}

/**
 * Poll until a follow button appears.
 * Uses DOM-to-ARIA bridge for locale-agnostic button detection.
 * Uses data-testid for locale-agnostic error page detection.
 *
 * Returns state (following / not_following / pending) with the matched node.
 */
async function pollForFollowButton(
  primitives: Primitives,
  handle: string,
  timeoutMs: number = FOLLOW_POLL_TIMEOUT_MS,
): Promise<{ state: FollowState; node: SnapshotNode }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkProfileError(primitives, handle, 'follow');
    const snapshot = await primitives.takeSnapshot();
    const detected = await detectFollowButton(primitives, snapshot, handle);
    if (detected) return detected;
    await new Promise(r => setTimeout(r, FOLLOW_POLL_INTERVAL_MS));
  }
  throw new ElementNotFound(`No follow/following button found for @${handle}`, { step: 'follow: detecting button state' });
}

type FollowActionParams = z.input<typeof TwitterFollowActionParamsSchema>;

export async function follow(
  primitives: Primitives,
  opts: FollowActionParams,
  trace: Trace = NOOP_TRACE,
): Promise<FollowResult> {
  const handle = resolveHandle(opts);
  return await trace.span('follow', async (rootSpan) => {
    rootSpan.set('handle', handle);
    await primitives.navigate(`https://x.com/${handle}`);
    await checkLoginRedirect(primitives, rootSpan);

    const { state: previousState, node } = await pollForFollowButton(primitives, handle);
    rootSpan.set('previousState', previousState);

    // Idempotent: already following or pending
    if (previousState === 'following' || previousState === 'pending') {
      return { action: 'follow' as const, handle, success: true, previousState, resultState: previousState };
    }

    // state is 'not_following' (testid = -follow)
    console.error(`[site-use] clicking Follow @${handle}...`);
    await primitives.click(node.uid);

    // Verify state transition:
    //   testid → -unfollow  → following (public account)
    //   testid → -cancel    → pending (protected account)
    //   testid stays -follow → no change yet, keep polling
    const deadline = Date.now() + FOLLOW_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, FOLLOW_POLL_INTERVAL_MS));
      const snapshot = await primitives.takeSnapshot();
      const detected = await detectFollowButton(primitives, snapshot, handle);
      if (detected && detected.state !== 'not_following') {
        rootSpan.set('resultState', detected.state);
        return { action: 'follow' as const, handle, success: true, previousState: 'not_following' as const, resultState: detected.state };
      }
    }
    throw new StateTransitionFailed(`Follow button clicked but state did not change for @${handle}`, { step: 'follow: verifying state transition' });
  });
}

export async function unfollow(
  primitives: Primitives,
  opts: FollowActionParams,
  trace: Trace = NOOP_TRACE,
): Promise<FollowResult> {
  const handle = resolveHandle(opts);
  return await trace.span('unfollow', async (rootSpan) => {
    rootSpan.set('handle', handle);
    await primitives.navigate(`https://x.com/${handle}`);
    await checkLoginRedirect(primitives, rootSpan);

    const { state: previousState, node } = await pollForFollowButton(primitives, handle);
    rootSpan.set('previousState', previousState);

    // Idempotent: not following
    if (previousState === 'not_following') {
      return { action: 'unfollow' as const, handle, success: true, previousState: 'not_following', resultState: 'not_following' as const };
    }

    // Both pending (-cancel) and following (-unfollow) require:
    //   1. Click the button
    //   2. Handle confirmation dialog (confirmationSheetConfirm)
    //   3. Verify state transition
    const label = previousState === 'pending' ? 'cancel pending' : 'unfollow';
    console.error(`[site-use] ${label}: clicking ${previousState === 'pending' ? 'Cancel' : 'Following'} @${handle}...`);
    await primitives.click(node.uid);

    // Handle confirmation dialog — DOM-to-ARIA bridge pattern (see guide §3)
    await rootSpan.span('confirmDialog', async (s) => {
      const dialogDeadline = Date.now() + FOLLOW_POLL_TIMEOUT_MS;
      while (Date.now() < dialogDeadline) {
        await new Promise(r => setTimeout(r, FOLLOW_POLL_INTERVAL_MS));

        const confirmText = await primitives.evaluate<string | null>(`(() => {
          const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          return btn ? btn.textContent?.trim() ?? null : null;
        })()`);
        if (!confirmText) continue;

        const snapshot = await primitives.takeSnapshot();
        const exactMatch = findByDescriptor(snapshot, { role: 'button', name: confirmText });
        if (exactMatch) {
          await primitives.click(exactMatch.uid);
          s.set('method', 'dom-to-aria-exact');
          s.set('confirmText', confirmText);
          return;
        }

        const escaped = confirmText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fuzzyMatch = findByDescriptor(snapshot, { role: 'button', name: new RegExp(escaped, 'i') });
        if (fuzzyMatch) {
          await primitives.click(fuzzyMatch.uid);
          s.set('method', 'dom-to-aria-fuzzy');
          s.set('confirmText', confirmText);
          return;
        }

        throw new StateTransitionFailed(
          `Confirm button DOM text "${confirmText}" found but no ARIA match`,
          { step: `${label}: confirming dialog`, diagnostics: { domText: confirmText } },
        );
      }
      throw new StateTransitionFailed(`Confirmation dialog did not appear for ${label}`, { step: `${label}: confirming dialog` });
    });

    // Verify state transition
    const deadline = Date.now() + FOLLOW_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, FOLLOW_POLL_INTERVAL_MS));
      const snapshot = await primitives.takeSnapshot();
      const detected = await detectFollowButton(primitives, snapshot, handle);
      if (detected && detected.state === 'not_following') {
        rootSpan.set('resultState', 'not_following');
        return { action: 'unfollow' as const, handle, success: true, previousState, resultState: 'not_following' as const };
      }
    }
    throw new StateTransitionFailed(`Unfollow clicked but state did not change for @${handle}`, { step: 'unfollow: verifying state transition' });
  });
}
