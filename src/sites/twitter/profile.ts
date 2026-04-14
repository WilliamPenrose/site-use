import type { Primitives } from '../../primitives/types.js';
import type { ProfileResult, ProfileWithTimelineResult, FollowListResult, Tweet } from './types.js';
import type { FeedItem } from '../../registry/types.js';
import { tweetToFeedItem } from './feed-item.js';
import { resolveHandle, checkLoginRedirect, checkProfileError, getSelfHandle } from './navigate.js';
import { parseProfileResponse, parseGraphQLTimeline, parseTweet, GRAPHQL_PROFILE_PATTERN, GRAPHQL_USER_TWEETS_PATTERN, GRAPHQL_USER_TWEETS_AND_REPLIES_PATTERN } from './extractors.js';
import { SiteUseError } from '../../errors.js';
import { NOOP_TRACE, type Trace } from '../../trace.js';
import { getFollowList } from './follow-list.js';
import { createDataCollector } from '../../ops/data-collector.js';
import { collectData } from './workflows.js';
import { findByDescriptor } from '../../ops/matchers.js';

const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_POLL_INTERVAL_MS = 500;

const PROFILE_TAB_SELECTOR = '[data-testid="primaryColumn"] [role="tablist"] [role="tab"]';

/**
 * Unified profile entry point.
 * Dispatches to follow-list mode, timeline mode, or basic profile info.
 */
export async function getProfile(
  primitives: Primitives,
  opts: {
    handle?: string;
    url?: string;
    following?: boolean;
    followers?: boolean;
    posts?: boolean;
    replies?: boolean;
    count?: number;
    debug?: boolean;
  },
  trace: Trace = NOOP_TRACE,
): Promise<ProfileResult | ProfileWithTimelineResult | FollowListResult> {
  if ((opts.following || opts.followers) && (opts.posts || opts.replies)) {
    throw new SiteUseError('InvalidParams',
      '--following/--followers cannot be combined with --posts/--replies',
      { retryable: false, step: 'profile: validating params' },
    );
  }
  if (opts.following) {
    return getFollowList(primitives, { ...opts, direction: 'following' }, trace);
  }
  if (opts.followers) {
    return getFollowList(primitives, { ...opts, direction: 'followers' }, trace);
  }
  if (opts.posts || opts.replies) {
    return getProfileWithTimeline(primitives, opts, trace);
  }
  return getProfileInfo(primitives, opts, trace);
}

/**
 * Fetch basic profile info (original #5 logic).
 */
async function getProfileInfo(
  primitives: Primitives,
  opts: { handle?: string; url?: string; debug?: boolean },
  trace: Trace = NOOP_TRACE,
): Promise<ProfileResult> {
  const handle = resolveHandle(opts);

  return await trace.span('getProfile', async (rootSpan) => {
    rootSpan.set('handle', handle);

    let captured: string | null = null;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_PROFILE_PATTERN,
      (response) => {
        if (!captured) {
          captured = response.body;
        }
      },
    );

    try {
      await primitives.navigate(`https://x.com/${handle}`);
      await checkLoginRedirect(primitives, rootSpan);
      await checkProfileError(primitives, handle, 'profile');

      if (!captured) {
        const deadline = Date.now() + PROFILE_TIMEOUT_MS;
        while (!captured && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, PROFILE_POLL_INTERVAL_MS));
          await checkProfileError(primitives, handle, 'profile');
        }
      }

      if (!captured) {
        throw new SiteUseError('ElementNotFound',
          `No UserByScreenName response received for @${handle} within ${PROFILE_TIMEOUT_MS / 1000}s`,
          { retryable: true, step: 'profile: waiting for GraphQL response' },
        );
      }

      const selfHandle = await getSelfHandle(primitives);
      const result = parseProfileResponse(captured, selfHandle ?? undefined);
      rootSpan.set('userId', result.user.userId);
      rootSpan.set('isSelf', result.relationship === null);

      return result;
    } finally {
      cleanup();
    }
  });
}

/**
 * Fetch profile metadata + user's posts and/or replies.
 *
 * Navigation triggers UserByScreenName + UserTweets simultaneously.
 * If --replies, switches tab to with_replies after collecting posts.
 */
async function getProfileWithTimeline(
  primitives: Primitives,
  opts: {
    handle?: string;
    url?: string;
    posts?: boolean;
    replies?: boolean;
    count?: number;
    debug?: boolean;
  },
  trace: Trace = NOOP_TRACE,
): Promise<ProfileWithTimelineResult> {
  const handle = resolveHandle(opts);
  const count = opts.count ?? 20;

  return await trace.span('getProfileWithTimeline', async (rootSpan) => {
    rootSpan.set('handle', handle);
    rootSpan.set('posts', !!opts.posts);
    rootSpan.set('replies', !!opts.replies);
    rootSpan.set('count', count);

    // --- Phase 1: Navigate and capture profile + UserTweets ---

    let profileBody: string | null = null;

    const cleanupProfile = await primitives.interceptRequest(
      GRAPHQL_PROFILE_PATTERN,
      (response) => { if (!profileBody) profileBody = response.body; },
    );

    // Only intercept UserTweets when --posts is requested
    const tweetsCollector = opts.posts
      ? createDataCollector<import('./types.js').RawTweetData>()
      : null;

    const tweetsIntercept = tweetsCollector
      ? await primitives.interceptRequestWithControl(
          GRAPHQL_USER_TWEETS_PATTERN,
          (response) => {
            try {
              const parsed = parseGraphQLTimeline(response.body);
              tweetsCollector.push(...parsed);
            } catch { /* non-fatal */ }
          },
        )
      : null;

    try {
      await primitives.navigate(`https://x.com/${handle}`);
      await checkLoginRedirect(primitives, rootSpan);
      await checkProfileError(primitives, handle, 'profile');

      // Wait for profile data
      if (!profileBody) {
        const deadline = Date.now() + PROFILE_TIMEOUT_MS;
        while (!profileBody && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, PROFILE_POLL_INTERVAL_MS));
          await checkProfileError(primitives, handle, 'profile');
        }
      }

      if (!profileBody) {
        throw new SiteUseError('ElementNotFound',
          `No UserByScreenName response received for @${handle} within ${PROFILE_TIMEOUT_MS / 1000}s`,
          { retryable: true, step: 'profile-timeline: waiting for profile data' },
        );
      }

      const selfHandle = await getSelfHandle(primitives);
      const profileResult = parseProfileResponse(profileBody, selfHandle ?? undefined);
      rootSpan.set('userId', profileResult.user.userId);

      const result: ProfileWithTimelineResult = {
        user: profileResult.user,
        relationship: profileResult.relationship,
      };
      const errors: string[] = [];

      // --- Phase 2: Collect posts ---

      if (opts.posts && tweetsCollector) {
        try {
          // Wait for initial UserTweets data
          if (tweetsCollector.length === 0) {
            const satisfied = await tweetsCollector.waitUntil(() => tweetsCollector.length > 0, 5000);
            if (!satisfied) {
              throw new SiteUseError('ElementNotFound',
                'No UserTweets data received within 5s',
                { retryable: true, step: 'profile-timeline: waiting for tweets' },
              );
            }
          }

          // Scroll for more if needed
          const t0 = Date.now();
          if (tweetsCollector.length < count) {
            await collectData(primitives, tweetsCollector, {
              count, t0,
              hasInflightRequest: tweetsIntercept!.hasPending,
            }, rootSpan);
          }

          const posts = [...tweetsCollector.items]
            .map(parseTweet)
            .filter(t => !t.isAd)
            .slice(0, count)
            .map(tweetToFeedItem);

          result.posts = posts;
          rootSpan.set('postsReturned', posts.length);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`posts: ${msg}`);
          rootSpan.set('postsError', msg);
        }
      }

      // --- Phase 3: Collect replies (tab switch) ---

      if (opts.replies) {
        try {
          result.replies = await collectReplies(primitives, handle, count, rootSpan);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`replies: ${msg}`);
          rootSpan.set('repliesError', msg);
        }
      }

      if (errors.length > 0) result.errors = errors;
      return result;
    } finally {
      cleanupProfile();
      tweetsIntercept?.cleanup();
    }
  });
}

/**
 * Switch to Replies tab and collect the target user's replies.
 * Uses href-based DOM-to-ARIA bridge for locale-agnostic tab detection.
 */
async function collectReplies(
  primitives: Primitives,
  handle: string,
  count: number,
  span: import('../../trace.js').SpanHandle,
): Promise<FeedItem[]> {
  const repliesCollector = createDataCollector<import('./types.js').RawTweetData>();

  const intercept = await primitives.interceptRequestWithControl(
    GRAPHQL_USER_TWEETS_AND_REPLIES_PATTERN,
    (response) => {
      try {
        const parsed = parseGraphQLTimeline(response.body);
        repliesCollector.push(...parsed);
      } catch { /* non-fatal */ }
    },
  );

  try {
    // Find and click the Replies tab via href-based DOM-to-ARIA bridge
    await span.span('switchToReplies', async (s) => {
      // Phase 1: DOM — find tab with href containing /with_replies
      const tabText = await primitives.evaluate<string | null>(`(() => {
        const tabs = document.querySelectorAll('${PROFILE_TAB_SELECTOR}');
        for (const tab of tabs) {
          const anchor = tab.closest('a') || tab.querySelector('a');
          const href = anchor?.getAttribute('href') || tab.getAttribute('href') || '';
          if (href.includes('/with_replies')) {
            return tab.textContent?.trim() ?? null;
          }
        }
        return null;
      })()`);

      if (!tabText) {
        throw new SiteUseError('ElementNotFound',
          'Replies tab not found on profile page',
          { retryable: true, step: 'profile-timeline: finding replies tab' },
        );
      }

      s.set('repliesTabText', tabText);

      // Phase 2: ARIA — match text in snapshot and click
      const snapshot = await primitives.takeSnapshot();
      const escaped = tabText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const node = findByDescriptor(snapshot, { role: 'tab', name: new RegExp(`^\\s*${escaped}\\s*$`, 'i') });

      if (!node) {
        throw new SiteUseError('ElementNotFound',
          `Replies tab text "${tabText}" found in DOM but no ARIA match`,
          { retryable: true, step: 'profile-timeline: clicking replies tab' },
        );
      }

      await primitives.scrollIntoView(node.uid);
      await primitives.click(node.uid);
      s.set('clicked', true);
    });

    // Wait for UserTweetsAndReplies data
    if (repliesCollector.length === 0) {
      const satisfied = await repliesCollector.waitUntil(() => repliesCollector.length > 0, 5000);
      if (!satisfied) {
        throw new SiteUseError('ElementNotFound',
          'No UserTweetsAndReplies data received within 5s',
          { retryable: true, step: 'profile-timeline: waiting for replies' },
        );
      }
    }

    // Scroll for more data in rounds until we have enough filtered replies.
    // Replies tab contains both target user's replies AND other users' original
    // tweets (conversation context). The reply ratio varies widely — elonmusk
    // has ~29% replies (6 Module / 21 entries), so a fixed multiplier fails.
    const t0 = Date.now();
    let rawTarget = count * 3;
    let prevRawCount = repliesCollector.length;

    while (true) {
      if (repliesCollector.length < rawTarget) {
        await collectData(primitives, repliesCollector, {
          count: rawTarget, t0,
          hasInflightRequest: intercept.hasPending,
        }, span);
      }

      // Check: enough target-user replies in raw data?
      const filteredCount = repliesCollector.items
        .filter(raw =>
          raw.authorHandle.toLowerCase() === handle.toLowerCase() &&
          raw.inReplyTo !== undefined,
        ).length;

      if (filteredCount >= count) break;

      // No new data arrived — scrolling exhausted
      if (repliesCollector.length <= prevRawCount) break;

      prevRawCount = repliesCollector.length;
      rawTarget = repliesCollector.length + count * 3;
    }

    // Process: parse → build map → filter to target user's replies → enrich
    const allTweets = [...repliesCollector.items].map(parseTweet);
    const tweetMap = new Map<string, Tweet>();
    for (const t of allTweets) {
      tweetMap.set(t.id, t);
    }

    const targetReplies = allTweets
      .filter(t =>
        t.author.handle.toLowerCase() === handle.toLowerCase() &&
        t.inReplyTo !== undefined,
      )
      .slice(0, count);

    // Enrich inReplyTo.text from the tweet map
    for (const reply of targetReplies) {
      if (reply.inReplyTo && !reply.inReplyTo.text) {
        const original = tweetMap.get(reply.inReplyTo.tweetId);
        if (original) {
          reply.inReplyTo.text = original.text;
        }
      }
    }

    const feedItems = targetReplies.map(tweetToFeedItem);
    span.set('repliesReturned', feedItems.length);
    return feedItems;
  } finally {
    intercept.cleanup();
  }
}
