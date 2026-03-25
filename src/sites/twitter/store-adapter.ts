// src/sites/twitter/store-adapter.ts
import type { Tweet } from './types.js';
import type { IngestItem, MetricEntry } from '../../storage/types.js';

export function tweetsToIngestItems(tweets: Tweet[]): IngestItem[] {
  return tweets.map((tweet) => ({
    site: 'twitter',
    id: tweet.id,
    text: tweet.text,
    author: tweet.author.handle,
    timestamp: tweet.timestamp,
    url: tweet.url,
    rawJson: JSON.stringify(tweet),
    mentions: extractMentions(tweet.text),
    hashtags: extractHashtags(tweet.text),
    metrics: extractMetrics(tweet),
  }));
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
