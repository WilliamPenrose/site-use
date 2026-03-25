import { describe, it, expect } from 'vitest';
import { tweetToSearchResultItem } from '../../src/sites/twitter/store-adapter.js';
import type { Tweet } from '../../src/sites/twitter/types.js';

function makeTweet(overrides?: Partial<Tweet>): Tweet {
  return {
    id: '123',
    author: { handle: 'alice', name: 'Alice', following: true },
    text: 'hello world',
    timestamp: '2026-03-25T12:00:00Z',
    url: 'https://x.com/alice/status/123',
    metrics: { likes: 10, retweets: 2, replies: 1 },
    media: [],
    links: [],
    isRetweet: false,
    isAd: false,
    surfaceReason: 'original',
    ...overrides,
  };
}

describe('tweetToSearchResultItem', () => {
  it('maps core fields', () => {
    const item = tweetToSearchResultItem(makeTweet());
    expect(item.id).toBe('123');
    expect(item.site).toBe('twitter');
    expect(item.author).toBe('alice');
    expect(item.text).toBe('hello world');
    expect(item.timestamp).toBe('2026-03-25T12:00:00Z');
    expect(item.url).toBe('https://x.com/alice/status/123');
  });

  it('maps metrics into siteMeta', () => {
    const item = tweetToSearchResultItem(makeTweet());
    expect(item.siteMeta?.likes).toBe(10);
    expect(item.siteMeta?.retweets).toBe(2);
    expect(item.siteMeta?.replies).toBe(1);
    expect(item.siteMeta?.following).toBe(true);
  });

  it('maps surface context', () => {
    const item = tweetToSearchResultItem(makeTweet({
      surfaceReason: 'retweet',
      surfacedBy: 'bob',
    }));
    expect(item.siteMeta?.surfaceReason).toBe('retweet');
    expect(item.siteMeta?.surfacedBy).toBe('bob');
  });

  it('maps quoted tweet preserving full structure', () => {
    const qt = makeTweet({ id: '456', author: { handle: 'carol', name: 'Carol', following: false }, text: 'quoted text' });
    const item = tweetToSearchResultItem(makeTweet({ quotedTweet: qt }));
    const mapped = item.siteMeta?.quotedTweet as Tweet;
    expect(mapped).toBeDefined();
    expect(mapped.author.handle).toBe('carol');
    expect(mapped.text).toBe('quoted text');
  });
});
