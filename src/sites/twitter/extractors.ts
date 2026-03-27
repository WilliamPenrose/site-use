import type { Primitives } from '../../primitives/types.js';
import type { Tweet, TweetMedia, RawTweetData, RawTweetMedia, FeedMeta } from './types.js';

const GRAPHQL_TIMELINE_PATTERN = /\/i\/api\/graphql\/.*\/Home.*Timeline/;
const MAX_STALE_ROUNDS = 3;

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

/** Extract expanded URLs from tweet entities (external links the author included). */
function extractLinks(entities: { urls?: any[] }, excludePattern?: RegExp): string[] {
  return (entities.urls ?? [])
    .map((u: any) => u.expanded_url as string | undefined)
    .filter((url): url is string => url != null && (!excludePattern || !excludePattern.test(url)));
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
      following: raw.following,
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
    links: raw.links,
    isRetweet: raw.isRetweet,
    isAd: raw.isAd,
    surfaceReason: raw.surfaceReason,
    surfacedBy: raw.surfacedBy,
    quotedTweet: raw.quotedTweet ? parseTweet(raw.quotedTweet) : undefined,
    inReplyTo: raw.inReplyTo,
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

  const handles = tweets.flatMap((t) => {
    const h = [t.author.handle];
    if (t.surfacedBy) h.push(t.surfacedBy);
    return h;
  });
  const uniqueHandles = [...new Set(handles)];

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

/** Extract a tweet from an itemContent object (shared by Item and Module paths). */
export function extractTweetFromItemContent(
  itemContent: any,
  results: RawTweetData[],
): void {
  if (itemContent?.promotedMetadata) return;

  const tweetResult = itemContent?.tweet_results?.result;
  if (!tweetResult) return;

  const raw = extractFromTweetResult(tweetResult);
  if (raw) results.push(raw);
}

/** Process entries from a TimelineAddEntries instruction. */
function processEntries(entries: any[], results: RawTweetData[]): void {
  for (const entry of entries) {
    const content = entry.content;
    if (!content) continue;

    if (content.entryType === 'TimelineTimelineItem') {
      extractTweetFromItemContent(content.itemContent, results);
    } else if (content.entryType === 'TimelineTimelineModule') {
      for (const moduleItem of content.items ?? []) {
        const itemContent = moduleItem?.item?.itemContent;
        if (itemContent?.__typename !== 'TimelineTweet') continue;
        extractTweetFromItemContent(itemContent, results);
      }
    }
    // TimelineTimelineCursor: skip (correct)
  }
}

/** Parse GraphQL HomeTimeline response into RawTweetData[]. */
export function parseGraphQLTimeline(body: string): RawTweetData[] {
  const data = JSON.parse(body);
  const instructions =
    data?.data?.home?.home_timeline_urt?.instructions ?? [];

  const results: RawTweetData[] = [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddToModule') {
      for (const moduleItem of instruction.moduleItems ?? []) {
        const itemContent = moduleItem?.item?.itemContent;
        if (itemContent?.__typename !== 'TimelineTweet') continue;
        extractTweetFromItemContent(itemContent, results);
      }
    } else if (instruction.type === 'TimelinePinEntry') {
      const content = instruction.entry?.content;
      if (content?.entryType === 'TimelineTimelineItem') {
        extractTweetFromItemContent(content.itemContent, results);
      }
    } else {
      // TimelineAddEntries (default) — also handles untyped instructions
      processEntries(instruction.entries ?? [], results);
    }
  }

  return results;
}

export function extractFromTweetResult(
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
  if (!legacy) return null;

  // --- Retweet: extract inner tweet as main content ---
  const retweetedResult = legacy.retweeted_status_result?.result;
  if (retweetedResult) {
    const outerUserResult = (core as any)?.core?.user_results?.result;
    const outerUserInfo = outerUserResult?.core;
    const surfacedBy = outerUserInfo?.screen_name ?? '';

    const inner = extractFromTweetResult(retweetedResult);
    if (!inner) return null;

    inner.surfaceReason = 'retweet';
    inner.surfacedBy = surfacedBy;
    inner.isRetweet = true;
    return inner;
  }

  // --- Normal tweet extraction ---
  const userResult = (core as any)?.core?.user_results?.result;
  const userInfo = userResult?.core;
  if (!userInfo) return null;

  const handle: string = userInfo.screen_name ?? '';
  const name: string = userInfo.name ?? '';
  const following: boolean = userResult?.relationship_perspectives?.following === true;
  const createdAt: string = legacy.created_at ?? '';
  const idStr: string = legacy.id_str ?? (core as any).rest_id ?? '';

  const timestamp = createdAt
    ? new Date(createdAt).toISOString()
    : '';

  const url = handle && idStr
    ? `https://x.com/${handle}/status/${idStr}`
    : '';

  const entities = legacy.entities ?? {};

  // note_tweet: prefer long-form text over legacy.full_text
  const noteTweet = (core as any).note_tweet?.note_tweet_results?.result;
  let text: string;
  if (noteTweet?.text) {
    const noteEntities = noteTweet.entity_set ?? {};
    text = processFullText(noteTweet.text, { urls: noteEntities.urls, media: noteEntities.media });
  } else {
    text = processFullText(legacy.full_text ?? '', entities);
  }

  const media = extractMedia(legacy);

  // Determine surfaceReason (priority: quote > reply > original)
  const quotedResult = (core as any).quoted_status_result?.result;
  const isQuote = legacy.is_quote_status === true && quotedResult;

  // Extract links — exclude the quoted tweet's embed URL if this is a quote tweet
  const excludeQuoteUrl = isQuote ? /^https:\/\/(twitter\.com|x\.com)\/\w+\/status\// : undefined;
  const links = extractLinks(entities, excludeQuoteUrl);
  const isReply = legacy.in_reply_to_status_id_str != null;

  let surfaceReason: RawTweetData['surfaceReason'] = 'original';
  if (isQuote) surfaceReason = 'quote';
  else if (isReply) surfaceReason = 'reply';

  // Extract quotedTweet if present
  let quotedTweet: RawTweetData | undefined;
  if (isQuote) {
    quotedTweet = extractFromTweetResult(quotedResult) ?? undefined;
  }

  // Extract reply metadata
  let inReplyTo: RawTweetData['inReplyTo'];
  if (isReply) {
    inReplyTo = {
      handle: legacy.in_reply_to_screen_name ?? '',
      tweetId: legacy.in_reply_to_status_id_str,
    };
  }

  return {
    authorHandle: handle,
    authorName: name,
    following,
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
    links,
    isRetweet: false,
    isAd: false,
    surfaceReason,
    surfacedBy: undefined,
    quotedTweet,
    inReplyTo,
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
    await primitives.scroll({ direction: 'down' });
    await wait(1500);
  }

  return interceptedRaw;
}
