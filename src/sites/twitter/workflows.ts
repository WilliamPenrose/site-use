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
import { SiteUseError, StateTransitionFailed, ElementNotFound, UserNotFound } from '../../errors.js';
import type { RawTweetData, SearchTab } from './types.js';
import { z } from 'zod';
import { findByDescriptor } from '../../ops/matchers.js';
import type { FollowResult, FollowState } from './types.js';
import { TwitterFollowActionParamsSchema } from './types.js';
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

const TAB_DISCOVERY_POLL_MS = 500;
const TAB_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Ensure the given tab is selected on the Twitter home timeline.
 *
 * Two-phase approach (JS discovery + ensure interaction):
 * 1. evaluate() reads the tab's textContent by position index (locale-agnostic),
 *    polling until the tab element appears in the DOM (SPA may still be rendering)
 * 2. ensure() uses that text as ARIA name to click via CDP Input (human-like)
 *
 * This preserves the full anti-detection path (Bezier mouse trajectory,
 * coordinate jitter, throttle) while being language-independent.
 */
export async function ensureTab(
  primitives: Primitives,
  tab: TimelineFeed,
): Promise<'already_there' | 'transitioned'> {
  const index = TAB_INDICES[tab];
  const ensure = makeEnsureState(primitives);

  // Phase 1: JS discovery — poll for the tab's locale-specific text by position
  const deadline = Date.now() + TAB_DISCOVERY_TIMEOUT_MS;
  let tabText: string | null = null;
  while (Date.now() < deadline) {
    tabText = await primitives.evaluate<string | null>(`(() => {
      const tabs = document.querySelectorAll('${TAB_SELECTOR}');
      return tabs[${index}]?.textContent?.trim() ?? null;
    })()`);
    if (tabText) break;
    await new Promise(r => setTimeout(r, TAB_DISCOVERY_POLL_MS));
  }

  if (!tabText) {
    throw new StateTransitionFailed(
      `Tab at index ${index} not found in DOM after ${TAB_DISCOVERY_TIMEOUT_MS}ms`,
      { step: `ensureTab: reading tab text at index ${index}` },
    );
  }

  // Phase 2: ensure interaction — click via CDP with human-like behavior
  const result = await ensure({ role: 'tab', name: tabText, selected: true });
  return result.action;
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

// ── Follow / Unfollow ────────────────────────────────────────────

const FOLLOW_POLL_INTERVAL_MS = 500;
const FOLLOW_POLL_TIMEOUT_MS = 10_000;

const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function normalizeHandle(handle: string): string {
  const h = handle.startsWith('@') ? handle.slice(1) : handle;
  if (!TWITTER_HANDLE_RE.test(h)) {
    throw new SiteUseError('InvalidParams', `Invalid Twitter handle: ${handle}`, { retryable: false });
  }
  return h;
}

function handleFromUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/(?:x\.com|twitter\.com)\/([^/?#]+)/);
  if (!match) return null;
  const segment = match[1];
  // Positive match: Twitter handles are 1-15 alphanumeric/underscore characters.
  // This rejects all non-profile paths (home, search, i, explore, etc.) without
  // maintaining an exclusion list.
  if (!TWITTER_HANDLE_RE.test(segment)) return null;
  return segment;
}

function resolveHandle(params: { handle?: string; url?: string }): string {
  if (params.handle) return normalizeHandle(params.handle);
  if (params.url) {
    const h = handleFromUrl(params.url);
    if (h) return h;
    throw new SiteUseError('InvalidParams', `Cannot extract handle from URL: ${params.url}`, { retryable: false });
  }
  throw new SiteUseError('InvalidParams', 'Either handle or url is required', { retryable: false });
}

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
      // -cancel has no ariaLabel, so we can't verify by @handle.
      // TODO: cross-check the numeric userId prefix in the testid against other
      // buttons' testids to confirm it belongs to the target user. Currently
      // accepts the first -cancel button, which is correct on a profile page
      // but could mismatch if a sidebar shows another user's -cancel button.
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
 * Check for error pages via data-testid (locale-agnostic).
 * - data-testid="error-detail" → page-level error (invalid path)
 * - data-testid="emptyState" WITHOUT a follow button → user does not exist / suspended
 * - data-testid="emptyState" WITH a follow button → protected account (not an error)
 *
 * Known gap: blocked-by-user state has no known data-testid. If a user is
 * blocked, pollForFollowButton will time out (10s) with ElementNotFound
 * instead of a fast, specific error. Acceptable until a data-testid for
 * the blocked state is identified.
 */
async function checkProfileError(primitives: Primitives, handle: string): Promise<void> {
  const errorType = await primitives.evaluate<string | null>(`(() => {
    if (document.querySelector('[data-testid="error-detail"]')) return 'errorDetail';
    if (document.querySelector('[data-testid="emptyState"]')) {
      // Protected accounts show emptyState ("posts are protected") alongside a follow/cancel button.
      // Only treat as error if there is no follow-related button for this user.
      const allBtns = document.querySelectorAll(
        'button[data-testid$="-follow"], button[data-testid$="-unfollow"], button[data-testid$="-cancel"]'
      );
      for (const btn of allBtns) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const testid = btn.getAttribute('data-testid') || '';
        // -cancel has no ariaLabel; presence of any -cancel button means a protected
        // account with a pending request — not a "user not found" error.
        // TODO: validate userId prefix in testid matches the target user (same gap as detectFollowButton).
        if (testid.endsWith('-cancel')) return null;
        if (ariaLabel.includes('@' + ${JSON.stringify(handle)})) return null;
      }
      return 'emptyState';
    }
    return null;
  })()`);
  if (errorType === 'emptyState') {
    throw new UserNotFound(`User @${handle} does not exist or is suspended`, { step: 'follow: checking user exists' });
  }
  if (errorType === 'errorDetail') {
    throw new UserNotFound(`Profile page for @${handle} not found`, { step: 'follow: checking page exists' });
  }
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
    await checkProfileError(primitives, handle);
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
