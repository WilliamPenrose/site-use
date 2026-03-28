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
  GRAPHQL_TIMELINE_PATTERN,
} from './extractors.js';
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
