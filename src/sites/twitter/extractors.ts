import type { Primitives } from '../../primitives/types.js';
import type { Tweet, RawTweetData, TimelineMeta } from './types.js';

const GRAPHQL_TIMELINE_PATTERN = /\/i\/api\/graphql\/.*\/Home.*Timeline/;
const MAX_STALE_ROUNDS = 3;
const TWITTER_SITE = 'twitter';

/**
 * Extract tweet ID from a tweet URL.
 * Pattern: https://x.com/{handle}/status/{id}
 */
function extractTweetId(url: string): string {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : url;
}

/** Convert browser-extracted raw data into a structured Tweet. Pure function. */
export function parseTweet(raw: RawTweetData): Tweet {
  return {
    id: extractTweetId(raw.url),
    author: {
      handle: raw.authorHandle,
      name: raw.authorName,
    },
    text: raw.text,
    timestamp: raw.timestamp,
    url: raw.url,
    metrics: {
      likes: raw.likes,
      retweets: raw.retweets,
      replies: raw.replies,
    },
    isRetweet: raw.isRetweet,
    isAd: raw.isAd,
  };
}

/** Build timeline coverage metadata from parsed tweets. Pure function. */
export function buildTimelineMeta(tweets: Tweet[]): TimelineMeta {
  if (tweets.length === 0) {
    return {
      tweetCount: 0,
      coveredUsers: [],
      coveredUserCount: 0,
      timeRange: { from: '', to: '' },
    };
  }

  const uniqueHandles = [...new Set(tweets.map((t) => t.author.handle))];

  const timestamps = tweets
    .map((t) => t.timestamp)
    .filter((ts) => ts !== '')
    .sort();

  return {
    tweetCount: tweets.length,
    coveredUsers: uniqueHandles,
    coveredUserCount: uniqueHandles.length,
    timeRange: {
      from: timestamps[0] ?? '',
      to: timestamps[timestamps.length - 1] ?? '',
    },
  };
}

/** Parse GraphQL HomeTimeline response into RawTweetData[]. */
export function parseGraphQLTimeline(body: string): RawTweetData[] {
  const data = JSON.parse(body);
  const instructions =
    data?.data?.home?.home_timeline_urt?.instructions ?? [];

  const results: RawTweetData[] = [];

  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];
    for (const entry of entries) {
      const content = entry.content;
      if (content?.entryType !== 'TimelineTimelineItem') continue;

      const tweetResult =
        content.itemContent?.tweet_results?.result;
      if (!tweetResult) continue;

      // Skip promoted tweets
      if (content.itemContent?.promotedMetadata) {
        continue;
      }

      const raw = extractFromTweetResult(tweetResult);
      if (raw) results.push(raw);
    }
  }

  return results;
}

function extractFromTweetResult(
  tweetResult: Record<string, unknown>,
): RawTweetData | null {
  // Handle "TweetWithVisibilityResults" wrapper
  const core =
    (tweetResult as any).__typename === 'TweetWithVisibilityResults'
      ? (tweetResult as any).tweet
      : tweetResult;

  const legacy = (core as any)?.legacy;
  const userLegacy = (core as any)?.core?.user_results?.result?.legacy;
  if (!legacy || !userLegacy) return null;

  const handle: string = userLegacy.screen_name ?? '';
  const name: string = userLegacy.name ?? '';
  const fullText: string = legacy.full_text ?? '';
  const createdAt: string = legacy.created_at ?? '';
  const idStr: string = legacy.id_str ?? (core as any).rest_id ?? '';

  // Convert Twitter date to ISO 8601
  const timestamp = createdAt
    ? new Date(createdAt).toISOString()
    : '';

  const url = handle && idStr
    ? `https://x.com/${handle}/status/${idStr}`
    : '';

  const isRetweet = legacy.retweeted_status_result != null;

  return {
    authorHandle: handle,
    authorName: name,
    text: fullText,
    timestamp,
    url,
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    replies: legacy.reply_count ?? 0,
    isRetweet,
    isAd: false,
  };
}

/**
 * Extract tweets from current timeline page via GraphQL interception.
 * R1: Unified signature — workflow does not know which strategy is used.
 * Encapsulates: GraphQL interception setup -> scroll loop -> teardown.
 *
 * NOTE: DOM fallback is not implemented yet. If GraphQL interception
 * captures no data (e.g. endpoint changes), returns empty array.
 * DOM fallback can be added later without changing this signature.
 */
export async function extractTweetsFromPage(
  primitives: Primitives,
  count: number,
): Promise<RawTweetData[]> {
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
    // Scroll to collect enough tweets
    let prevTotal = 0;
    let staleRounds = 0;

    while (staleRounds < MAX_STALE_ROUNDS) {
      if (interceptedRaw.length >= count) break;

      if (interceptedRaw.length <= prevTotal) {
        staleRounds++;
      } else {
        staleRounds = 0;
      }

      prevTotal = interceptedRaw.length;
      await primitives.scroll({ direction: 'down' }, TWITTER_SITE);
    }

    return interceptedRaw;
  } finally {
    cleanup();
  }
}
