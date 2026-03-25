import { describe, it, expect } from 'vitest';
import { tweetsToIngestItems } from '../../src/sites/twitter/store-adapter.js';
import type { Tweet } from '../../src/sites/twitter/types.js';

const TWEET: Tweet = {
  id: '123456',
  author: { handle: 'karpathy', name: 'Andrej Karpathy', following: true },
  text: 'Training with @openai on #AI and #ML today https://arxiv.org/abs/2401.00001',
  timestamp: '2026-03-20T10:00:00Z',
  url: 'https://x.com/karpathy/status/123456',
  metrics: { likes: 1500, retweets: 83, replies: 42, views: 50000, bookmarks: 10, quotes: 5 },
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg?name=orig', width: 1200, height: 800 }],
  links: ['https://arxiv.org/abs/2401.00001'],
  isRetweet: false,
  isAd: false,
};

describe('tweetsToIngestItems', () => {
  it('maps Tweet fields to IngestItem', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    expect(item.site).toBe('twitter');
    expect(item.id).toBe('123456');
    expect(item.author).toBe('karpathy');
    expect(item.text).toBe(TWEET.text);
    expect(item.timestamp).toBe(TWEET.timestamp);
    expect(item.url).toBe(TWEET.url);
  });

  it('stores full tweet as rawJson (includes media, links, following)', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    const parsed = JSON.parse(item.rawJson);
    expect(parsed.media).toHaveLength(1);
    expect(parsed.author.name).toBe('Andrej Karpathy');
    expect(parsed.author.following).toBe(true);
    expect(parsed.links).toEqual(['https://arxiv.org/abs/2401.00001']);
  });

  it('extracts @mentions from text', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    expect(item.mentions).toEqual(['openai']);
  });

  it('extracts #hashtags from text (lowercased)', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    expect(item.hashtags).toEqual(['ai', 'ml']);
  });

  it('produces metrics array for filterable numeric fields', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    expect(item.metrics).toEqual(expect.arrayContaining([
      { metric: 'likes', numValue: 1500 },
      { metric: 'retweets', numValue: 83 },
      { metric: 'replies', numValue: 42 },
      { metric: 'views', numValue: 50000 },
    ]));
  });

  it('omits metrics with undefined values', () => {
    const sparse: Tweet = { ...TWEET, metrics: { likes: 10 } };
    const [item] = tweetsToIngestItems([sparse]);
    const metricNames = item.metrics!.map(m => m.metric);
    expect(metricNames).toContain('likes');
    expect(metricNames).not.toContain('retweets');
    expect(metricNames).not.toContain('views');
  });

  it('handles tweet with no mentions, hashtags, or links', () => {
    const plain: Tweet = { ...TWEET, text: 'Just a plain tweet', links: [] };
    const [item] = tweetsToIngestItems([plain]);
    expect(item.mentions).toEqual([]);
    expect(item.hashtags).toEqual([]);
  });

  it('does not have siteMeta, links, or media properties', () => {
    const [item] = tweetsToIngestItems([TWEET]);
    expect(item).not.toHaveProperty('siteMeta');
    expect(item).not.toHaveProperty('links');
    expect(item).not.toHaveProperty('media');
  });
});
