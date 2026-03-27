/**
 * Compute a variant signature string for a raw timeline entry.
 * Format: wrapper|type|following:bool[|media:type][|note_tweet][|has_urls]
 * Tombstone entries return just "tombstone".
 */
export function computeTimelineVariantSignature(rawEntry: unknown): string {
  const entry = rawEntry as Record<string, any>;
  const tweetResult = entry?.tweet_results?.result;
  if (!tweetResult) return 'unknown';

  const typename = tweetResult.__typename as string;

  // Tombstone detection
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
    return 'tombstone';
  }

  // Wrapper detection
  const wrapper = typename === 'TweetWithVisibilityResults' ? 'wrapped' : 'direct';
  const core = typename === 'TweetWithVisibilityResults' ? tweetResult.tweet : tweetResult;
  const legacy = core?.legacy;
  if (!legacy) return `${wrapper}|unknown`;

  // Tweet type
  const hasRetweet = legacy.retweeted_status_result?.result != null;
  const hasQuote = legacy.is_quote_status === true && core.quoted_status_result?.result != null;
  const hasReply = legacy.in_reply_to_status_id_str != null;
  let type = 'original';
  if (hasRetweet) type = 'retweet';
  else if (hasQuote) type = 'quote';
  else if (hasReply) type = 'reply';

  // Following
  const following = core.core?.user_results?.result?.relationship_perspectives?.following === true;

  const tags: string[] = [wrapper, type, `following:${following}`];

  // Media
  const mediaItems = legacy.extended_entities?.media ?? [];
  if (mediaItems.length > 0) {
    const mediaType = mediaItems[0].type as string;
    if (mediaType === 'video' || mediaType === 'animated_gif') {
      tags.push('media:video');
    } else if (mediaType === 'photo') {
      tags.push('media:photo');
    }
  }

  // Note tweet
  if (core.note_tweet?.note_tweet_results?.result) {
    tags.push('note_tweet');
  }

  // URLs
  const urls = legacy.entities?.urls ?? [];
  if (urls.length > 0) {
    tags.push('has_urls');
  }

  return tags.join('|');
}
