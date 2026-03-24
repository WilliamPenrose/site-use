// tests/unit/storage-query.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/storage/schema.js';
import { ingest } from '../../src/storage/ingest.js';
import { search, stats } from '../../src/storage/query.js';
import type { IngestItem } from '../../src/storage/types.js';

function makeItem(overrides: Partial<IngestItem> = {}): IngestItem {
  return {
    site: 'twitter',
    id: '1',
    text: 'AI agents are reshaping the world',
    author: 'alice',
    timestamp: '2026-03-20T10:00:00Z',
    url: 'https://x.com/alice/status/1',
    rawJson: '{}',
    mentions: [],
    hashtags: ['AI'],
    siteMeta: { likes: 100, retweets: 10, replies: 5, views: 5000, bookmarks: 2, quotes: 1, isRetweet: false, isAd: false },
    ...overrides,
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = initializeDatabase(':memory:');
  // Seed data
  ingest(db, [
    makeItem({ id: '1', text: 'AI agents are reshaping the world', author: 'alice', timestamp: '2026-03-20T10:00:00Z', hashtags: ['AI'], links: ['https://arxiv.org/abs/2401.00001'], media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/ai.jpg', width: 1200, height: 800 }] }),
    makeItem({ id: '2', text: 'Crypto markets showing volatility', author: 'bob', timestamp: '2026-03-19T08:00:00Z', hashtags: ['crypto'], links: ['https://coindesk.com/article'], media: [{ type: 'video', url: 'https://video.twimg.com/crypto.mp4', width: 1280, height: 720, duration: 30000 }], siteMeta: { likes: 200, retweets: 20, replies: 10, views: 8000, bookmarks: 5, quotes: 3, isRetweet: false, isAd: false } }),
    makeItem({ id: '3', text: 'Building AI systems with autonomous agents', author: 'alice', timestamp: '2026-03-21T12:00:00Z', hashtags: ['AI', 'agents'] }),
  ]);
});

afterEach(() => {
  db.close();
});

describe('search', () => {
  it('returns all items when no filters', () => {
    const result = search(db, {});
    expect(result.items).toHaveLength(3);
  });

  it('filters by author', () => {
    const result = search(db, { author: 'alice' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.author === 'alice')).toBe(true);
  });

  it('filters by time range (start_date/end_date)', () => {
    const result = search(db, { start_date: '2026-03-20T00:00:00Z' });
    expect(result.items).toHaveLength(2);
  });

  it('searches by FTS keyword', () => {
    const result = search(db, { query: 'AI' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.text.toLowerCase().includes('ai'))).toBe(true);
  });

  it('combines FTS + structured filters', () => {
    const result = search(db, { query: 'AI', author: 'alice' });
    expect(result.items).toHaveLength(2);
  });

  it('filters by hashtag', () => {
    const result = search(db, { hashtag: 'crypto' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('bob');
  });

  it('filters by mention', () => {
    ingest(db, [makeItem({ id: '4', text: 'Hey @openai check this out', author: 'carol', timestamp: '2026-03-18T06:00:00Z', mentions: ['openai'], hashtags: [] })]);
    const result = search(db, { mention: 'openai' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('carol');
  });

  it('normalizes mention input (strips @ and lowercases)', () => {
    ingest(db, [makeItem({ id: '5', text: 'cc @Tesla', author: 'dave', timestamp: '2026-03-17T06:00:00Z', mentions: ['tesla'], hashtags: [] })]);
    const result = search(db, { mention: '@Tesla' });
    expect(result.items).toHaveLength(1);
  });

  it('returns mentions in results', () => {
    ingest(db, [makeItem({ id: '6', text: 'Hey @openai @anthropic', author: 'eve', timestamp: '2026-03-16T06:00:00Z', mentions: ['openai', 'anthropic'], hashtags: [] })]);
    const result = search(db, { author: 'eve' });
    expect(result.items[0].mentions).toEqual(expect.arrayContaining(['openai', 'anthropic']));
    expect(result.items[0].mentions).toHaveLength(2);
  });

  it('strips mentions when not in fields', () => {
    ingest(db, [makeItem({ id: '7', text: '@foo hi', author: 'fay', timestamp: '2026-03-15T06:00:00Z', mentions: ['foo'], hashtags: [] })]);
    const result = search(db, { fields: ['author'], author: 'fay' });
    expect(result.items[0].mentions).toBeUndefined();
  });

  it('filters by link substring', () => {
    const result = search(db, { link: 'arxiv.org' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('alice');
  });

  it('returns links in results', () => {
    const result = search(db, {});
    // Item 3 has no links
    const item3 = result.items.find((i) => i.id === '3');
    expect(item3?.links).toBeUndefined();
    // Item 1 has a link
    const item1 = result.items.find((i) => i.id === '1');
    expect(item1?.links).toEqual(['https://arxiv.org/abs/2401.00001']);
  });

  it('filters by min_likes', () => {
    const result = search(db, { min_likes: 150 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('bob');
  });

  it('filters by min_retweets', () => {
    const result = search(db, { min_retweets: 15 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('bob');
  });

  it('respects max_results', () => {
    const result = search(db, { max_results: 1 });
    expect(result.items).toHaveLength(1);
  });

  it('orders by time descending by default', () => {
    const result = search(db, {});
    const timestamps = result.items.map((i) => i.timestamp);
    expect(timestamps).toEqual([...timestamps].sort().reverse());
  });

  it('filters returned fields', () => {
    const result = search(db, { fields: ['author', 'url'] });
    expect(result.items[0].author).toBe('alice');
    expect(result.items[0].url).toContain('x.com');
    expect(result.items[0].text).toBeUndefined();
    expect(result.items[0].siteMeta).toBeUndefined();
  });

  it('includes engagement metrics when text is in fields', () => {
    const result = search(db, { fields: ['text'] });
    expect(result.items[0].text).toBeDefined();
    expect(result.items[0].siteMeta).toBeDefined();
    expect(result.items[0].author).toBeUndefined();
  });

  it('strips engagement metrics when text is not in fields', () => {
    const result = search(db, { fields: ['author', 'url'] });
    expect(result.items[0].author).toBeDefined();
    expect(result.items[0].text).toBeUndefined();
    expect(result.items[0].siteMeta).toBeUndefined();
  });

  it('strips links when not in fields', () => {
    const result = search(db, { fields: ['author'] });
    expect(result.items[0].links).toBeUndefined();
  });

  it('includes links when in fields', () => {
    const result = search(db, { fields: ['links'], author: 'alice' });
    const item1 = result.items.find((i) => i.id === '1');
    expect(item1?.links).toEqual(['https://arxiv.org/abs/2401.00001']);
    expect(item1?.text).toBeUndefined();
  });

  it('returns media in results', () => {
    const result = search(db, {});
    const item1 = result.items.find((i) => i.id === '1');
    expect(item1?.media).toEqual([{ type: 'photo', url: 'https://pbs.twimg.com/media/ai.jpg', width: 1200, height: 800 }]);
    const item2 = result.items.find((i) => i.id === '2');
    expect(item2?.media).toEqual([{ type: 'video', url: 'https://video.twimg.com/crypto.mp4', width: 1280, height: 720, duration: 30000 }]);
    const item3 = result.items.find((i) => i.id === '3');
    expect(item3?.media).toBeUndefined();
  });

  it('strips media when not in fields', () => {
    const result = search(db, { fields: ['author'] });
    expect(result.items[0].media).toBeUndefined();
  });

  it('includes media when in fields', () => {
    const result = search(db, { fields: ['media'], author: 'alice' });
    const item1 = result.items.find((i) => i.id === '1');
    expect(item1?.media).toHaveLength(1);
    expect(item1?.text).toBeUndefined();
  });

  it('returns all fields when fields is omitted', () => {
    const result = search(db, {});
    expect(result.items[0].text).not.toBe('');
    expect(result.items[0].author).not.toBe('');
  });

  it('returns all fields when fields is empty array', () => {
    const result = search(db, { fields: [] });
    expect(result.items[0].text).not.toBe('');
  });
});

describe('stats', () => {
  it('returns correct totals', () => {
    const s = stats(db);
    expect(s.totalItems).toBe(3);
    expect(s.bySite).toEqual({ twitter: 3 });
    expect(s.uniqueAuthors).toBe(2);
    expect(s.timeRange).toEqual({
      from: '2026-03-19T08:00:00Z',
      to: '2026-03-21T12:00:00Z',
    });
  });

  it('returns null timeRange on empty db', () => {
    const emptyDb = initializeDatabase(':memory:');
    const s = stats(emptyDb);
    expect(s.totalItems).toBe(0);
    expect(s.timeRange).toBeNull();
    emptyDb.close();
  });
});
