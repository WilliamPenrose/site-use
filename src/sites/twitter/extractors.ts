import type { Primitives } from '../../primitives/types.js';
import type { Tweet, TweetMedia, RawTweetData, RawTweetMedia, FeedMeta } from './types.js';

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
 * Process tweet full_text: expand external t.co URLs, strip media t.co URLs, decode HTML entities.
 * Replacements are applied from end to start so indices stay valid.
 */
export function processFullText(
  fullText: string,
  entities: { urls?: any[]; media?: any[] },
): string {
  // Collect all replacements: { start, end, replacement }
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  // External URLs: replace t.co with expanded_url
  for (const u of entities.urls ?? []) {
    if (u.indices && u.expanded_url) {
      replacements.push({
        start: u.indices[0],
        end: u.indices[1],
        replacement: u.expanded_url,
      });
    }
  }

  // Media URLs: strip from text (already in media array)
  for (const m of entities.media ?? []) {
    if (m.indices) {
      replacements.push({
        start: m.indices[0],
        end: m.indices[1],
        replacement: '',
      });
    }
  }

  // Sort by start position descending so we can splice from the end
  replacements.sort((a, b) => b.start - a.start);

  let result = fullText;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return decodeHTMLEntities(result.trim());
}

/** Extract media items from GraphQL extended_entities or entities. */
function extractMedia(legacy: any): RawTweetMedia[] {
  const mediaItems =
    legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  const results: RawTweetMedia[] = [];

  for (const m of mediaItems) {
    const type = m.type as string;
    if (type !== 'photo' && type !== 'video' && type !== 'animated_gif') continue;

    const raw: RawTweetMedia = {
      type: type as RawTweetMedia['type'],
      mediaUrl: m.media_url_https ?? '',
      width: m.original_info?.width ?? 0,
      height: m.original_info?.height ?? 0,
    };

    if (type === 'video' || type === 'animated_gif') {
      const videoInfo = m.video_info;
      if (videoInfo?.duration_millis != null) {
        raw.durationMs = videoInfo.duration_millis;
      }
      // Pick highest bitrate mp4 variant
      const mp4Variants = (videoInfo?.variants ?? [])
        .filter((v: any) => v.content_type === 'video/mp4' && v.bitrate != null)
        .sort((a: any, b: any) => b.bitrate - a.bitrate);
      if (mp4Variants.length > 0) {
        raw.videoUrl = mp4Variants[0].url;
      }
    }

    results.push(raw);
  }

  return results;
}

/**
 * Extract tweet ID from a tweet URL.
 * Pattern: https://x.com/{handle}/status/{id}
 */
function extractTweetId(url: string): string {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : url;
}

/** Map RawTweetMedia (GraphQL types) to TweetMedia (API types). Pure function. */
function mapMedia(raw: RawTweetMedia): TweetMedia {
  const isVideo = raw.type === 'video' || raw.type === 'animated_gif';

  const media: TweetMedia = {
    type: raw.type === 'animated_gif' ? 'gif' : raw.type,
    url: isVideo
      ? (raw.videoUrl ?? raw.mediaUrl)
      : `${raw.mediaUrl}?name=orig`,
    width: raw.width,
    height: raw.height,
  };

  if (raw.durationMs != null) media.duration = raw.durationMs;
  if (isVideo) media.thumbnailUrl = raw.mediaUrl;

  return media;
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
      views: raw.views,
      bookmarks: raw.bookmarks,
      quotes: raw.quotes,
    },
    media: raw.media.map(mapMedia),
    isRetweet: raw.isRetweet,
    isAd: raw.isAd,
  };
}

/** Build feed coverage metadata from parsed tweets. Pure function. */
export function buildFeedMeta(tweets: Tweet[]): FeedMeta {
  if (tweets.length === 0) {
    return {
      coveredUsers: [],
      timeRange: { from: '', to: '' },
    };
  }

  const uniqueHandles = [...new Set(tweets.map((t) => t.author.handle))];

  const timestamps = tweets
    .map((t) => t.timestamp)
    .filter((ts) => ts !== '')
    .sort();

  return {
    coveredUsers: uniqueHandles,
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
  const typename = (tweetResult as any).__typename;

  // Explicitly skip known non-tweet types (deleted, protected, NSFW, etc.)
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
    return null;
  }

  // Handle "TweetWithVisibilityResults" wrapper
  const core =
    typename === 'TweetWithVisibilityResults'
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

  // Process text: expand external URLs, strip media URLs, decode HTML entities
  const text = processFullText(fullText, legacy.entities ?? {});

  // Extract media from extended_entities (preferred) or entities
  const media = extractMedia(legacy);

  return {
    authorHandle: handle,
    authorName: name,
    text,
    timestamp,
    url,
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    replies: legacy.reply_count ?? 0,
    views: (core as any).views?.count != null ? Number((core as any).views.count) : undefined,
    bookmarks: legacy.bookmark_count ?? undefined,
    quotes: legacy.quote_count ?? undefined,
    media,
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
