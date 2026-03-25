// src/sites/twitter/store-adapter.ts
import type { Tweet } from './types.js';
import type { IngestItem, MetricEntry } from '../../storage/types.js';

export function tweetsToIngestItems(tweets: Tweet[]): IngestItem[] {
  return tweets.map((tweet) => {
    const mentions = extractMentions(tweet.text);
    if (tweet.surfacedBy) mentions.push(tweet.surfacedBy);
    if (tweet.quotedTweet?.author.handle) mentions.push(tweet.quotedTweet.author.handle);
    if (tweet.inReplyTo?.handle) mentions.push(tweet.inReplyTo.handle);
    const uniqueMentions = [...new Set(mentions)];

    const metrics = extractMetrics(tweet);
    metrics.push({ metric: 'surface_reason', strValue: tweet.surfaceReason });
    metrics.push({ metric: 'following', numValue: tweet.author.following ? 1 : 0 });

    return {
      site: 'twitter',
      id: tweet.id,
      text: tweet.text,
      author: tweet.author.handle,
      timestamp: tweet.timestamp,
      url: tweet.url,
      rawJson: JSON.stringify(tweet),
      mentions: uniqueMentions,
      hashtags: extractHashtags(tweet.text),
      metrics,
    };
  });
}

function extractMetrics(tweet: Tweet): MetricEntry[] {
  const entries: Array<{ metric: string; value: number | undefined }> = [
    { metric: 'likes', value: tweet.metrics.likes },
    { metric: 'retweets', value: tweet.metrics.retweets },
    { metric: 'replies', value: tweet.metrics.replies },
    { metric: 'views', value: tweet.metrics.views },
    { metric: 'bookmarks', value: tweet.metrics.bookmarks },
    { metric: 'quotes', value: tweet.metrics.quotes },
  ];
  return entries
    .filter((e): e is { metric: string; value: number } => e.value != null)
    .map((e) => ({ metric: e.metric, numValue: e.value }));
}

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/@(\w+)/g);
  return [...matches].map((m) => m[1]);
}

function extractHashtags(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1].toLowerCase());
}
