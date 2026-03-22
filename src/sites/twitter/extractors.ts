import type { Primitives } from '../../primitives/types.js';
import type { Tweet, RawTweetData, TimelineMeta } from './types.js';

const GRAPHQL_TIMELINE_PATTERN = /\/i\/api\/graphql\/.*\/Home.*Timeline/;
const MAX_STALE_ROUNDS = 3;
const TWITTER_SITE = 'twitter';

/** Decode common HTML entities found in Twitter GraphQL full_text. */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos);/g;

function decodeHTMLEntities(text: string): string {
  return text.replace(ENTITY_RE, (match) => HTML_ENTITIES[match] ?? match);
}

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
  const userResult = (core as any)?.core?.user_results?.result;
  // User info may be under .core (current) or .legacy (older schema)
  const userInfo = userResult?.core ?? userResult?.legacy;
  if (!legacy || !userInfo) return null;

  const handle: string = userInfo.screen_name ?? '';
  const name: string = userInfo.name ?? '';
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
    text: decodeHTMLEntities(fullText),
    timestamp,
    url,
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    replies: legacy.reply_count ?? 0,
    isRetweet,
    isAd: false,
  };
}

export { GRAPHQL_TIMELINE_PATTERN };

/** Short delay to allow async GraphQL responses to arrive. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scroll timeline and collect intercepted tweets until count is reached.
 * Caller is responsible for setting up interception before navigation —
 * this function only scrolls and waits for data to accumulate.
 */
export async function collectTweetsFromTimeline(
  primitives: Primitives,
  interceptedRaw: RawTweetData[],
  count: number,
): Promise<RawTweetData[]> {
  // Wait for initial page load GraphQL response
  await wait(2000);

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
    await wait(1500);
  }

  return interceptedRaw;
}
