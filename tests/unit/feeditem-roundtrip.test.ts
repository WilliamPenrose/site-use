/**
 * Cross-layer round-trip test: FeedItem → feedItemsToIngestItems → DB → search → siteMeta
 *
 * This test covers the full production path that was missed by existing tests:
 * - store-adapter.test.ts tests ingestion only (never queries back)
 * - storage-query.test.ts uses hand-crafted Tweet-shaped rawJson (wrong structure)
 * - local-mode.test.ts uses hand-written tweetToIngestItem (bypasses real adapter)
 *
 * The bug: feedItemsToIngestItems stores rawJson as JSON.stringify(FeedItem),
 * which nests fields under siteMeta (e.g. siteMeta.likes, siteMeta.surfaceReason).
 * But the display schema paths assume Tweet structure (metrics.likes, top-level surfaceReason).
 * So resolveItem fails silently and siteMeta is never populated on search results.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/storage/schema.js';
import { ingest } from '../../src/storage/ingest.js';
import { search, registerDisplaySchema } from '../../src/storage/query.js';
import { feedItemsToIngestItems } from '../../src/sites/twitter/store-adapter.js';
import type { FeedItem } from '../../src/registry/types.js';
import { twitterDisplaySchema } from '../../src/sites/twitter/display.js';

const RETWEET_ITEM: FeedItem = {
  id: 'rt-1',
  author: { handle: 'elonmusk', name: 'Elon Musk' },
  text: 'Interesting thread on AI safety',
  timestamp: '2026-03-25T16:00:00Z',
  url: 'https://x.com/elonmusk/status/rt-1',
  media: [],
  links: [],
  siteMeta: {
    likes: 5000,
    retweets: 800,
    replies: 200,
    views: 100000,
    bookmarks: 50,
    quotes: 30,
    following: false,
    isRetweet: true,
    isAd: false,
    surfaceReason: 'retweet',
    surfacedBy: 'karpathy',
  },
};

const ORIGINAL_ITEM: FeedItem = {
  id: 'orig-1',
  author: { handle: 'karpathy', name: 'Andrej Karpathy' },
  text: 'New blog post on LLM training',
  timestamp: '2026-03-25T14:00:00Z',
  url: 'https://x.com/karpathy/status/orig-1',
  media: [],
  links: ['https://karpathy.ai/blog'],
  siteMeta: {
    likes: 2000,
    retweets: 300,
    replies: 50,
    views: 40000,
    following: true,
    surfaceReason: 'original',
  },
};

const QUOTE_ITEM: FeedItem = {
  id: 'qt-1',
  author: { handle: 'ylecun', name: 'Yann LeCun' },
  text: 'Disagree with this take',
  timestamp: '2026-03-25T12:00:00Z',
  url: 'https://x.com/ylecun/status/qt-1',
  media: [],
  links: [],
  siteMeta: {
    likes: 800,
    retweets: 50,
    replies: 100,
    views: 20000,
    following: true,
    surfaceReason: 'quote',
    quotedTweet: {
      id: 'qt-target',
      author: { handle: 'sama', name: 'Sam Altman' },
      text: 'AGI is near',
      surfaceReason: 'original',
      metrics: { likes: 10000, retweets: 2000 },
    },
  },
};

const REPLY_ITEM: FeedItem = {
  id: 'reply-1',
  author: { handle: 'goodfellow', name: 'Ian Goodfellow' },
  text: 'Great point about GANs',
  timestamp: '2026-03-25T10:00:00Z',
  url: 'https://x.com/goodfellow/status/reply-1',
  media: [],
  links: [],
  siteMeta: {
    likes: 100,
    retweets: 5,
    replies: 10,
    views: 3000,
    following: false,
    surfaceReason: 'reply',
    inReplyTo: { handle: 'bengio', tweetId: 'parent-1' },
  },
};

let db: DatabaseSync;

beforeEach(() => {
  db = initializeDatabase(':memory:');
  registerDisplaySchema('twitter', twitterDisplaySchema);
  const items = feedItemsToIngestItems([RETWEET_ITEM, ORIGINAL_ITEM, QUOTE_ITEM, REPLY_ITEM]);
  ingest(db, items);
});

afterEach(() => {
  db.close();
});

describe('FeedItem round-trip: siteMeta resolution', () => {
  it('resolves numeric metrics (likes, retweets, views) from FeedItem rawJson', () => {
    const result = search(db, { author: 'karpathy' });
    const item = result.items[0];
    expect(item.siteMeta).toBeDefined();
    expect(item.siteMeta!.likes).toBe(2000);
    expect(item.siteMeta!.retweets).toBe(300);
    expect(item.siteMeta!.views).toBe(40000);
  });

  it('resolves surfaceReason from FeedItem rawJson', () => {
    const result = search(db, { author: 'elonmusk' });
    const item = result.items[0];
    expect(item.siteMeta).toBeDefined();
    expect(item.siteMeta!.surfaceReason).toBe('retweet');
  });

  it('resolves surfacedBy from FeedItem rawJson', () => {
    const result = search(db, { author: 'elonmusk' });
    const item = result.items[0];
    expect(item.siteMeta!.surfacedBy).toBe('karpathy');
  });

  it('resolves following from FeedItem rawJson', () => {
    const result = search(db, { author: 'karpathy' });
    expect(result.items[0].siteMeta!.following).toBe(true);

    const result2 = search(db, { author: 'elonmusk' });
    expect(result2.items[0].siteMeta!.following).toBe(false);
  });

  it('resolves quotedTweet from FeedItem rawJson', () => {
    const result = search(db, { author: 'ylecun' });
    const item = result.items[0];
    expect(item.siteMeta!.quotedTweet).toBeDefined();
    const qt = item.siteMeta!.quotedTweet as Record<string, unknown>;
    expect((qt.author as Record<string, unknown>).handle).toBe('sama');
    expect(qt.text).toBe('AGI is near');
  });

  it('resolves inReplyTo from FeedItem rawJson', () => {
    const result = search(db, { author: 'goodfellow' });
    const item = result.items[0];
    expect(item.siteMeta!.inReplyTo).toBeDefined();
    const replyTo = item.siteMeta!.inReplyTo as { handle: string };
    expect(replyTo.handle).toBe('bengio');
  });
});

describe('FeedItem round-trip: JSON output includes siteMeta', () => {
  it('JSON output contains surfaceReason and surfacedBy for retweets', () => {
    const result = search(db, { author: 'elonmusk' });
    const json = JSON.parse(JSON.stringify(result));
    const item = json.items[0];
    expect(item.siteMeta.surfaceReason).toBe('retweet');
    expect(item.siteMeta.surfacedBy).toBe('karpathy');
  });

  it('JSON output contains engagement metrics', () => {
    const result = search(db, { author: 'karpathy' });
    const json = JSON.parse(JSON.stringify(result));
    const item = json.items[0];
    expect(item.siteMeta.likes).toBe(2000);
    expect(item.siteMeta.retweets).toBe(300);
  });
});
