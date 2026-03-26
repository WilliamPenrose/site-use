import { describe, it, expect } from 'vitest';
import { tweetToFeedItem, TwitterSiteMetaSchema } from '../feed-item.js';
import type { Tweet } from '../types.js';

const sampleTweet: Tweet = {
  id: '123',
  author: { handle: 'alice', name: 'Alice', following: true },
  text: 'Hello world',
  timestamp: '2026-03-26T12:00:00Z',
  url: 'https://x.com/alice/status/123',
  metrics: { likes: 10, retweets: 2, replies: 1, views: 100, bookmarks: 0, quotes: 0 },
  media: [{ type: 'photo', url: 'https://img.com/1.jpg', width: 800, height: 600 }],
  links: ['https://example.com'],
  isRetweet: false,
  isAd: false,
  surfaceReason: 'original' as const,
};

describe('tweetToFeedItem', () => {
  it('maps common fields correctly', () => {
    const item = tweetToFeedItem(sampleTweet);
    expect(item.id).toBe('123');
    expect(item.author).toEqual({ handle: 'alice', name: 'Alice' });
    expect(item.text).toBe('Hello world');
    expect(item.timestamp).toBe('2026-03-26T12:00:00Z');
    expect(item.url).toBe('https://x.com/alice/status/123');
    expect(item.media).toHaveLength(1);
    expect(item.links).toEqual(['https://example.com']);
  });

  it('puts Twitter-specific fields in siteMeta', () => {
    const item = tweetToFeedItem(sampleTweet);
    expect(item.siteMeta.likes).toBe(10);
    expect(item.siteMeta.retweets).toBe(2);
    expect(item.siteMeta.following).toBe(true);
    expect(item.siteMeta.surfaceReason).toBe('original');
    expect(item.siteMeta.isRetweet).toBe(false);
    expect(item.siteMeta.isAd).toBe(false);
  });

  it('includes optional fields when present', () => {
    const tweet: Tweet = {
      ...sampleTweet,
      surfacedBy: 'bob',
      quotedTweet: { ...sampleTweet, id: '456' },
      inReplyTo: { handle: 'carol', tweetId: '789' },
    };
    const item = tweetToFeedItem(tweet);
    expect(item.siteMeta.surfacedBy).toBe('bob');
    expect(item.siteMeta.quotedTweet).toBeDefined();
    expect(item.siteMeta.inReplyTo).toEqual({ handle: 'carol', tweetId: '789' });
  });

  it('validates siteMeta against TwitterSiteMetaSchema', () => {
    const item = tweetToFeedItem(sampleTweet);
    const result = TwitterSiteMetaSchema.safeParse(item.siteMeta);
    expect(result.success).toBe(true);
  });
});
