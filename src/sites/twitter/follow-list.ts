import type { Primitives } from '../../primitives/types.js';
import type { DataCollector } from '../../ops/data-collector.js';
import type { UserProfile, FollowListResult } from './types.js';
import { resolveHandle, checkLoginRedirect, checkProfileError, getSelfHandle } from './navigate.js';
import { parseFollowListResponse, GRAPHQL_FOLLOW_LIST_PATTERN, GRAPHQL_PROFILE_PATTERN } from './extractors.js';
import { SiteUseError } from '../../errors.js';
import { createDataCollector } from '../../ops/data-collector.js';
import { NOOP_TRACE, NOOP_SPAN, type Trace, type SpanHandle } from '../../trace.js';

// Conservative parameters for follow-list scrolling (see spec: account safety)
const DATA_WAIT_MS_MIN = 3000;
const DATA_WAIT_MS_MAX = 5000;
const SCROLL_STEP_DELAY_MS = 300;
const SCROLLS_PER_ROUND = 3;
const MAX_STALE_ROUNDS = 1;
const FOLLOW_LIST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

function randomDataWait(): number {
  return DATA_WAIT_MS_MIN + Math.random() * (DATA_WAIT_MS_MAX - DATA_WAIT_MS_MIN);
}

export interface CollectFollowListResult {
  scrollRounds: number;
}

/**
 * Scroll the follow list page and collect users until count is reached
 * or no more data arrives.
 *
 * Known limitation: Twitter's Following/Followers pages currently only return
 * ~70 users in the initial GraphQL response and do not trigger additional
 * pagination requests on scroll. The scroll here serves as a probe — if Twitter
 * re-enables pagination in the future, this will pick it up automatically.
 *
 * Conservative params: 3-5s random wait, MAX_STALE_ROUNDS=1 (first stale = stop).
 */
export async function collectFollowList(
  primitives: Primitives,
  collector: DataCollector<UserProfile>,
  opts: { count: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<CollectFollowListResult> {
  const { count } = opts;

  if (collector.length >= count) {
    console.error(`[site-use] already have ${collector.length}/${count} users, skipping scroll`);
    return { scrollRounds: 0 };
  }

  console.error(`[site-use] scrolling to collect ${count} users...`);
  let staleRounds = 0;
  let round = 0;

  while (staleRounds < MAX_STALE_ROUNDS) {
    if (collector.length >= count) break;

    round++;
    const prevTotal = collector.length;

    await span.span(`scroll_${round}`, async (s) => {
      for (let i = 0; i < SCROLLS_PER_ROUND; i++) {
        await primitives.scroll({ direction: 'down' });
        if (collector.length > prevTotal) break;
        if (i < SCROLLS_PER_ROUND - 1) {
          await new Promise(r => setTimeout(r, SCROLL_STEP_DELAY_MS));
        }
      }

      const waitMs = randomDataWait();
      const satisfied = await collector.waitUntil(() => collector.length > prevTotal, waitMs);

      s.set('satisfied', satisfied);
      s.set('dataCount', collector.length);
      s.set('newUsers', collector.length - prevTotal);
      s.set('waitMs', Math.round(waitMs));

      if (satisfied) {
        staleRounds = 0;
        console.error(`[site-use] scroll ${round}: collected ${collector.length}/${count} users`);
      } else {
        staleRounds++;
        console.error(`[site-use] scroll ${round}: no more data from server`);
      }
    });
  }

  return { scrollRounds: round };
}

/**
 * Fetch a user's following or followers list.
 */
export async function getFollowList(
  primitives: Primitives,
  opts: {
    handle?: string;
    url?: string;
    direction: 'following' | 'followers';
    count?: number;
  },
  trace: Trace = NOOP_TRACE,
): Promise<FollowListResult> {
  const { direction, count = 20 } = opts;

  // Resolve handle: if not provided, get self handle
  let handle: string;
  if (opts.handle || opts.url) {
    handle = resolveHandle(opts);
  } else {
    const selfHandle = await getSelfHandle(primitives);
    if (!selfHandle) {
      throw new SiteUseError('InvalidParams',
        'Cannot determine logged-in user. Specify --handle explicitly.',
        { retryable: false },
      );
    }
    handle = selfHandle;
  }

  return await trace.span('getFollowList', async (rootSpan) => {
    rootSpan.set('handle', handle);
    rootSpan.set('direction', direction);
    rootSpan.set('count', count);

    const collector = createDataCollector<UserProfile>();
    let graphqlCount = 0;
    let isProtected = false;

    // Intercept follow-list GraphQL responses
    const cleanupFollowList = await primitives.interceptRequest(
      GRAPHQL_FOLLOW_LIST_PATTERN,
      (response) => {
        try {
          const users = parseFollowListResponse(response.body);
          collector.push(...users);
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch (e) {
          // Parse failures are non-fatal — may be non-user responses on the same pattern
          console.error(`[site-use] follow-list interceptor: parse skipped — ${e instanceof Error ? e.message : e}`);
        }
      },
    );

    // Intercept UserByScreenName to detect protected accounts
    // Twitter sends this on /following and /followers pages but does NOT send
    // Following/Followers GraphQL for protected accounts you don't follow.
    const cleanupProfile = await primitives.interceptRequest(
      GRAPHQL_PROFILE_PATTERN,
      (response) => {
        try {
          const json = JSON.parse(response.body);
          const result = json?.data?.user?.result;
          if (result?.privacy?.protected === true) {
            isProtected = true;
            rootSpan.set('protected', true);
          }
        } catch {
          // Non-fatal
        }
      },
    );

    try {
      const url = `https://x.com/${handle}/${direction}`;
      await primitives.navigate(url);
      await checkLoginRedirect(primitives, rootSpan);
      await checkProfileError(primitives, handle, direction);

      // Wait for initial GraphQL response
      if (collector.length === 0) {
        const deadline = Date.now() + FOLLOW_LIST_TIMEOUT_MS;
        while (collector.length === 0 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          await checkProfileError(primitives, handle, direction);

          // Protected account: no follow-list GraphQL will ever arrive
          if (isProtected) {
            throw new SiteUseError('ProtectedAccount',
              `@${handle} is a protected account — ${direction} list is not visible`,
              { retryable: false, step: `${direction}: protected account detected` },
            );
          }
        }
      }

      if (collector.length === 0) {
        throw new SiteUseError('ElementNotFound',
          `No ${direction} data received for @${handle} within ${FOLLOW_LIST_TIMEOUT_MS / 1000}s`,
          { retryable: true, step: `${direction}: waiting for GraphQL response` },
        );
      }

      // Scroll to collect more if needed
      let hasMore = collector.length > count; // initial response already exceeded count
      if (collector.length < count) {
        const scrollResult = await rootSpan.span('collectFollowList', async (s) => {
          return collectFollowList(primitives, collector, { count }, s);
        });
        // hasMore = we filled the count AND were still getting data when we stopped
        hasMore = collector.length >= count && scrollResult.scrollRounds > 0;
      }

      const users = [...collector.items].slice(0, count);
      rootSpan.set('totalCollected', collector.length);
      rootSpan.set('returned', users.length);

      if (users.length < count && !hasMore) {
        console.error(
          `[site-use] returned ${users.length}/${count} users — ` +
          `Twitter returned ${collector.length} in initial response, no further pagination available`,
        );
      }

      return {
        users,
        meta: {
          totalReturned: users.length,
          hasMore,
          owner: handle,
        },
      };
    } finally {
      cleanupFollowList();
      cleanupProfile();
    }
  });
}
