// src/sites/twitter/store-adapter.ts
import type { Tweet } from './types.js';
import type { IngestItem } from '../../storage/types.js';

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
    links: tweet.links,
    media: tweet.media.map((m) => ({
      type: m.type,
      url: m.url,
      width: m.width,
      height: m.height,
      ...(m.duration != null ? { duration: m.duration } : {}),
    })),
    siteMeta: {
      following: tweet.author.following,
      likes: tweet.metrics.likes,
      retweets: tweet.metrics.retweets,
      replies: tweet.metrics.replies,
      views: tweet.metrics.views,
      bookmarks: tweet.metrics.bookmarks,
      quotes: tweet.metrics.quotes,
      isRetweet: tweet.isRetweet,
      isAd: tweet.isAd,
    },
  }));
}

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/@(\w+)/g);
  return [...matches].map((m) => m[1]);
}

function extractHashtags(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1].toLowerCase());
}
