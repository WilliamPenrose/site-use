import { describe, it, expect } from 'vitest';
import {
  TweetAuthorSchema,
  TweetSchema,
  FeedMetaSchema,
  FeedResultSchema,
  RawTweetDataSchema,
} from '../types.js';

describe('TweetAuthorSchema', () => {
  it('accepts valid author', () => {
    const result = TweetAuthorSchema.safeParse({
      handle: 'karpathy',
      name: 'Andrej Karpathy',
      following: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing handle', () => {
    const result = TweetAuthorSchema.safeParse({ name: 'Andrej' });
    expect(result.success).toBe(false);
  });
});

describe('TweetSchema', () => {
  const validTweet = {
    id: '2034416944074613174',
    author: { handle: 'karpathy', name: 'Andrej Karpathy', following: true },
    text: 'Hello world',
    timestamp: '2026-03-18T23:49:31.000Z',
    url: 'https://x.com/karpathy/status/2034416944074613174',
    metrics: { likes: 100, retweets: 10, replies: 5 },
    media: [],
    links: [],
    isRetweet: false,
    isAd: false,
    surfaceReason: 'original',
  };

  it('accepts valid tweet', () => {
    const result = TweetSchema.safeParse(validTweet);
    expect(result.success).toBe(true);
  });

  it('allows optional metrics fields', () => {
    const result = TweetSchema.safeParse({
      ...validTweet,
      metrics: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { text, ...noText } = validTweet;
    const result = TweetSchema.safeParse(noText);
    expect(result.success).toBe(false);
  });
});

describe('RawTweetDataSchema', () => {
  it('accepts valid raw data', () => {
    const result = RawTweetDataSchema.safeParse({
      authorHandle: 'steipete',
      authorName: 'Peter Steinberger',
      following: false,
      text: 'Hear me out...',
      timestamp: '2026-03-18T23:49:31.000Z',
      url: 'https://x.com/steipete/status/123',
      likes: 1200,
      retweets: 83,
      replies: 163,
      media: [],
      links: [],
      isRetweet: false,
      isAd: false,
      surfaceReason: 'original',
    });
    expect(result.success).toBe(true);
  });
});

describe('RawTweetDataSchema new fields', () => {
  const base = {
    authorHandle: 'test', authorName: 'Test', following: true,
    text: 'hello', timestamp: '', url: '', likes: 0, retweets: 0,
    replies: 0, media: [], links: [], isRetweet: false, isAd: false,
    surfaceReason: 'original' as const,
  };

  it('accepts all surfaceReason enum values', () => {
    for (const reason of ['original', 'retweet', 'quote', 'reply'] as const) {
      const result = RawTweetDataSchema.safeParse({ ...base, surfaceReason: reason });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid surfaceReason', () => {
    const result = RawTweetDataSchema.safeParse({ ...base, surfaceReason: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts optional surfacedBy', () => {
    const result = RawTweetDataSchema.safeParse({ ...base, surfacedBy: 'peter' });
    expect(result.success).toBe(true);
  });

  it('accepts optional inReplyTo', () => {
    const result = RawTweetDataSchema.safeParse({
      ...base,
      surfaceReason: 'reply',
      inReplyTo: { handle: 'dimillian', tweetId: '999' },
    });
    expect(result.success).toBe(true);
  });
});

describe('TweetSchema new fields', () => {
  const baseTweet = {
    id: '1', author: { handle: 'a', name: 'A', following: true },
    text: 'hi', timestamp: '', url: '', metrics: {},
    media: [], links: [], isRetweet: false, isAd: false,
    surfaceReason: 'original' as const,
  };

  it('accepts quotedTweet (recursive)', () => {
    const result = TweetSchema.safeParse({
      ...baseTweet,
      surfaceReason: 'quote',
      quotedTweet: { ...baseTweet, id: '2' },
    });
    expect(result.success).toBe(true);
  });
});

describe('FeedMetaSchema', () => {
  it('accepts valid meta', () => {
    const result = FeedMetaSchema.safeParse({
      coveredUsers: ['karpathy', 'steipete'],
      timeRange: {
        from: '2026-03-18T20:00:00.000Z',
        to: '2026-03-18T23:49:31.000Z',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('FeedResultSchema', () => {
  it('accepts valid result with tweets and meta', () => {
    const result = FeedResultSchema.safeParse({
      tweets: [],
      meta: {
        coveredUsers: [],
        timeRange: { from: '', to: '' },
      },
    });
    expect(result.success).toBe(true);
  });
});
