// src/sites/twitter/store-adapter.ts
import type { Tweet } from './types.js';
import type { FeedItem } from '../../registry/types.js';
import type { IngestItem, MetricEntry, SearchResultItem } from '../../storage/types.js';

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

export function tweetToSearchResultItem(tweet: Tweet): SearchResultItem {
  return {
    id: tweet.id,
    site: 'twitter',
    text: tweet.text,
    author: tweet.author.handle,
    timestamp: tweet.timestamp,
    url: tweet.url,
    links: tweet.links,
    media: tweet.media,
    siteMeta: {
      likes: tweet.metrics.likes,
      retweets: tweet.metrics.retweets,
      replies: tweet.metrics.replies,
      views: tweet.metrics.views,
      bookmarks: tweet.metrics.bookmarks,
      quotes: tweet.metrics.quotes,
      following: tweet.author.following,
      surfaceReason: tweet.surfaceReason,
      surfacedBy: tweet.surfacedBy,
      quotedTweet: tweet.quotedTweet,
      inReplyTo: tweet.inReplyTo,
    },
  };
}

export function feedItemsToIngestItems(items: FeedItem[]): IngestItem[] {
  return items.map((item) => {
    const meta = item.siteMeta as Record<string, unknown>;
    const mentions = extractMentions(item.text);
    if (typeof meta.surfacedBy === 'string') mentions.push(meta.surfacedBy);
    const qt = meta.quotedTweet as Record<string, unknown> | undefined;
    if (qt) {
      const qtAuthor = qt.author as Record<string, unknown> | undefined;
      if (qtAuthor && typeof qtAuthor.handle === 'string') mentions.push(qtAuthor.handle);
    }
    const inReplyTo = meta.inReplyTo as { handle: string; tweetId: string } | undefined;
    if (inReplyTo?.handle) mentions.push(inReplyTo.handle);
    const uniqueMentions = [...new Set(mentions)];

    const metrics = extractMetricsFromSiteMeta(meta);
    if (typeof meta.surfaceReason === 'string') {
      metrics.push({ metric: 'surface_reason', strValue: meta.surfaceReason });
    }
    if (typeof meta.following === 'boolean') {
      metrics.push({ metric: 'following', numValue: meta.following ? 1 : 0 });
    }

    return {
      site: 'twitter',
      id: item.id,
      text: item.text,
      author: item.author.handle,
      timestamp: item.timestamp,
      url: item.url,
      rawJson: JSON.stringify(item),
      mentions: uniqueMentions,
      hashtags: extractHashtags(item.text),
      metrics,
    };
  });
}

function extractMetricsFromSiteMeta(meta: Record<string, unknown>): MetricEntry[] {
  const keys = ['likes', 'retweets', 'replies', 'views', 'bookmarks', 'quotes'];
  const entries: MetricEntry[] = [];
  for (const key of keys) {
    const val = meta[key];
    if (typeof val === 'number') {
      entries.push({ metric: key, numValue: val });
    }
  }
  return entries;
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
