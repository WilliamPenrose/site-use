import { describe, it, expect } from 'vitest';
import {
  TweetAuthorSchema,
  TweetSchema,
  FeedMetaSchema,
  FeedResultSchema,
  RawTweetDataSchema,
  TweetDetailParamsSchema,
  UserProfileSchema,
  RelationshipSchema,
  ProfileResultSchema,
  TwitterProfileParamsSchema,
  FollowListResultSchema,
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

describe('TweetDetailParamsSchema', () => {
  it('accepts valid x.com tweet URL with defaults', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/shawn_pana/status/2037688071144317428',
    });
    expect(result.url).toBe('https://x.com/shawn_pana/status/2037688071144317428');
    expect(result.count).toBe(20);
    expect(result.debug).toBe(false);
  });

  it('accepts twitter.com URL', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://twitter.com/user/status/123456',
    });
    expect(result.url).toBe('https://twitter.com/user/status/123456');
  });

  it('accepts URL with query params', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/user/status/123456?s=20&t=abc',
    });
    expect(result.url).toContain('123456');
  });

  it('rejects non-tweet URL', () => {
    expect(() => TweetDetailParamsSchema.parse({
      url: 'https://x.com/user',
    })).toThrow();
  });

  it('rejects non-URL string', () => {
    expect(() => TweetDetailParamsSchema.parse({
      url: 'not-a-url',
    })).toThrow();
  });

  it('accepts custom count', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/user/status/123',
      count: 50,
    });
    expect(result.count).toBe(50);
  });
});

describe('UserProfileSchema', () => {
  it('validates a complete user profile', () => {
    const result = UserProfileSchema.safeParse({
      userId: '1590927428',
      handle: 'hwwaanng',
      displayName: 'Hwang',
      bio: 'AI Startup, Design/Vibe/Shape',
      website: 'https://hwang.fun',
      location: 'Shanghai',
      avatarUrl: 'https://pbs.twimg.com/profile_images/1361512556930600969/LBwP2_YZ.jpg',
      followersCount: 20458,
      followingCount: 3785,
      tweetsCount: 8120,
      likesCount: 23244,
      verified: true,
      createdAt: 'Sat Jul 13 12:35:29 +0000 2013',
      bannerUrl: 'https://pbs.twimg.com/profile_banners/1590927428/1765202554',
    });
    expect(result.success).toBe(true);
  });

  it('allows optional fields to be undefined', () => {
    const result = UserProfileSchema.safeParse({
      userId: '123',
      handle: 'test',
      displayName: 'Test',
      bio: '',
      followersCount: 0,
      followingCount: 0,
      tweetsCount: 0,
      likesCount: 0,
      verified: false,
      createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
    });
    expect(result.success).toBe(true);
  });
});

describe('ProfileResultSchema', () => {
  it('validates profile with relationship', () => {
    const result = ProfileResultSchema.safeParse({
      user: {
        userId: '123', handle: 'test', displayName: 'Test', bio: '',
        followersCount: 0, followingCount: 0, tweetsCount: 0, likesCount: 0,
        verified: false, createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
      },
      relationship: {
        youFollowThem: true, theyFollowYou: false, blocking: false, muting: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates profile with null relationship (self-profile)', () => {
    const result = ProfileResultSchema.safeParse({
      user: {
        userId: '123', handle: 'test', displayName: 'Test', bio: '',
        followersCount: 0, followingCount: 0, tweetsCount: 0, likesCount: 0,
        verified: false, createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
      },
      relationship: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('TwitterProfileParamsSchema', () => {
  it('accepts handle', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'elonmusk' });
    expect(result.success).toBe(true);
  });

  it('accepts url', () => {
    const result = TwitterProfileParamsSchema.safeParse({ url: 'https://x.com/elonmusk' });
    expect(result.success).toBe(true);
  });

  it('rejects when neither handle nor url provided', () => {
    const result = TwitterProfileParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('FollowListResultSchema', () => {
  it('validates a follow list result with users', () => {
    const result = FollowListResultSchema.safeParse({
      users: [{
        userId: '123', handle: 'test', displayName: 'Test', bio: '',
        followersCount: 100, followingCount: 50, tweetsCount: 10, likesCount: 5,
        verified: false, createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
      }],
      meta: { totalReturned: 1, hasMore: false, owner: 'myhandle' },
    });
    expect(result.success).toBe(true);
  });

  it('validates empty follow list', () => {
    const result = FollowListResultSchema.safeParse({
      users: [],
      meta: { totalReturned: 0, hasMore: false, owner: 'myhandle' },
    });
    expect(result.success).toBe(true);
  });
});

describe('TwitterProfileParamsSchema — follow list mode', () => {
  it('accepts --following without handle (query self)', () => {
    const result = TwitterProfileParamsSchema.safeParse({ following: true });
    expect(result.success).toBe(true);
  });

  it('accepts --followers without handle (query self)', () => {
    const result = TwitterProfileParamsSchema.safeParse({ followers: true });
    expect(result.success).toBe(true);
  });

  it('accepts --following with handle', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'test', following: true });
    expect(result.success).toBe(true);
  });

  it('accepts --following with count', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'test', following: true, count: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects --following and --followers together', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'test', following: true, followers: true });
    expect(result.success).toBe(false);
  });

  it('rejects count > 500', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'test', following: true, count: 501 });
    expect(result.success).toBe(false);
  });

  it('still requires handle/url when no --following/--followers', () => {
    const result = TwitterProfileParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('still accepts basic profile mode (handle only)', () => {
    const result = TwitterProfileParamsSchema.safeParse({ handle: 'test' });
    expect(result.success).toBe(true);
  });
});
