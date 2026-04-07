import { describe, it, expect } from 'vitest';
import { feedItemsToIngestItems } from '../store-adapter.js';
import type { FeedItem } from '../../../registry/types.js';

const FEED_ITEM: FeedItem = {
  id: '123456',
  author: { handle: 'karpathy', name: 'Andrej Karpathy' },
  text: 'Training with @openai on #AI and #ML today https://arxiv.org/abs/2401.00001',
  timestamp: '2026-03-20T10:00:00Z',
  url: 'https://x.com/karpathy/status/123456',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg?name=orig', width: 1200, height: 800 }],
  links: ['https://arxiv.org/abs/2401.00001'],
  siteMeta: {
    likes: 1500,
    retweets: 83,
    replies: 42,
    views: 50000,
    bookmarks: 10,
    quotes: 5,
    following: true,
    isRetweet: false,
    isAd: false,
    surfaceReason: 'original',
  },
};

describe('feedItemsToIngestItems', () => {
  it('maps FeedItem fields to IngestItem', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    expect(item.site).toBe('twitter');
    expect(item.id).toBe('123456');
    expect(item.author).toBe('karpathy');
    expect(item.text).toBe(FEED_ITEM.text);
    expect(item.timestamp).toBe(FEED_ITEM.timestamp);
    expect(item.url).toBe(FEED_ITEM.url);
  });

  it('stores full FeedItem as rawJson (includes media, links, following)', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    const parsed = JSON.parse(item.rawJson);
    expect(parsed.media).toHaveLength(1);
    expect(parsed.author.name).toBe('Andrej Karpathy');
    expect(parsed.siteMeta.following).toBe(true);
    expect(parsed.links).toEqual(['https://arxiv.org/abs/2401.00001']);
  });

  it('extracts @mentions from text', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    expect(item.mentions).toEqual(['openai']);
  });

  it('extracts #hashtags from text (lowercased)', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    expect(item.hashtags).toEqual(['ai', 'ml']);
  });

  it('produces metrics array for filterable numeric fields', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    expect(item.metrics).toEqual(expect.arrayContaining([
      { metric: 'likes', numValue: 1500 },
      { metric: 'retweets', numValue: 83 },
      { metric: 'replies', numValue: 42 },
      { metric: 'views', numValue: 50000 },
    ]));
  });

  it('omits metrics with undefined values', () => {
    const sparse: FeedItem = {
      ...FEED_ITEM,
      siteMeta: { ...FEED_ITEM.siteMeta, likes: 10, retweets: undefined, views: undefined },
    };
    const [item] = feedItemsToIngestItems([sparse]);
    const metricNames = item.metrics!.map(m => m.metric);
    expect(metricNames).toContain('likes');
    expect(metricNames).not.toContain('retweets');
    expect(metricNames).not.toContain('views');
  });

  it('handles item with no mentions, hashtags, or links', () => {
    const plain: FeedItem = { ...FEED_ITEM, text: 'Just a plain tweet', links: [] };
    const [item] = feedItemsToIngestItems([plain]);
    expect(item.mentions).toEqual([]);
    expect(item.hashtags).toEqual([]);
  });

  it('does not have siteMeta, links, or media properties', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM]);
    expect(item).not.toHaveProperty('siteMeta');
    expect(item).not.toHaveProperty('links');
    expect(item).not.toHaveProperty('media');
  });

  it('includes surfacedBy in mentions for retweets', () => {
    const rt: FeedItem = {
      ...FEED_ITEM,
      siteMeta: { ...FEED_ITEM.siteMeta, surfaceReason: 'retweet', surfacedBy: 'GoogleDeepMind' },
    };
    const [item] = feedItemsToIngestItems([rt]);
    expect(item.mentions).toContain('GoogleDeepMind');
  });

  it('includes quotedTweet author in mentions', () => {
    const qt: FeedItem = {
      ...FEED_ITEM,
      siteMeta: {
        ...FEED_ITEM.siteMeta,
        surfaceReason: 'quote',
        quotedTweet: {
          id: '999',
          author: { handle: 'dimillian', name: 'Dimillian' },
          text: 'Some quoted text',
          surfaceReason: 'original',
        },
      },
    };
    const [item] = feedItemsToIngestItems([qt]);
    expect(item.mentions).toContain('dimillian');
  });

  it('includes inReplyTo handle in mentions', () => {
    const reply: FeedItem = {
      ...FEED_ITEM,
      text: 'Just a plain reply',
      siteMeta: {
        ...FEED_ITEM.siteMeta,
        surfaceReason: 'reply',
        inReplyTo: { handle: 'someone', tweetId: '888' },
      },
    };
    const [item] = feedItemsToIngestItems([reply]);
    expect(item.mentions).toContain('someone');
  });

  it('stores surface_reason as strValue metric', () => {
    const rt: FeedItem = {
      ...FEED_ITEM,
      siteMeta: { ...FEED_ITEM.siteMeta, surfaceReason: 'retweet', surfacedBy: 'x' },
    };
    const [item] = feedItemsToIngestItems([rt]);
    const srMetric = item.metrics!.find(m => m.metric === 'surface_reason');
    expect(srMetric).toEqual({ metric: 'surface_reason', strValue: 'retweet' });
  });

  it('deduplicates mentions', () => {
    const rt: FeedItem = {
      ...FEED_ITEM,
      text: 'Mentioning @GoogleDeepMind here',
      siteMeta: { ...FEED_ITEM.siteMeta, surfaceReason: 'retweet', surfacedBy: 'GoogleDeepMind' },
    };
    const [item] = feedItemsToIngestItems([rt]);
    const count = item.mentions!.filter(m => m === 'GoogleDeepMind').length;
    expect(count).toBe(1);
  });

  it('returns sourceTabs when context.tab is provided', () => {
    const [item] = feedItemsToIngestItems([FEED_ITEM], { tab: 'vibe coding' });
    expect(item.sourceTabs).toEqual(['vibe coding']);
    // And does NOT smuggle source_tab through metrics anymore
    const sourceTabMetric = item.metrics?.find(m => m.metric === 'source_tab');
    expect(sourceTabMetric).toBeUndefined();
  });

  it('omits sourceTabs when context is missing or has no tab', () => {
    const [withoutContext] = feedItemsToIngestItems([FEED_ITEM]);
    expect(withoutContext.sourceTabs).toBeUndefined();

    const [emptyContext] = feedItemsToIngestItems([FEED_ITEM], {});
    expect(emptyContext.sourceTabs).toBeUndefined();
  });
});
