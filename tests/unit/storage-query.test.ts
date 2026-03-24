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
    makeItem({ id: '1', text: 'AI agents are reshaping the world', author: 'alice', timestamp: '2026-03-20T10:00:00Z', hashtags: ['AI'] }),
    makeItem({ id: '2', text: 'Crypto markets showing volatility', author: 'bob', timestamp: '2026-03-19T08:00:00Z', hashtags: ['crypto'], siteMeta: { likes: 200, retweets: 20, replies: 10, views: 8000, bookmarks: 5, quotes: 3, isRetweet: false, isAd: false } }),
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

  it('returns only requested engagement fields and strips bookmarks/quotes', () => {
    const result = search(db, { fields: ['likes'] });
    const meta = result.items[0].siteMeta as Record<string, unknown>;
    expect(meta.likes).toBeDefined();
    expect(meta.retweets).toBeUndefined();
    expect(meta.bookmarks).toBeUndefined();
    expect(meta.quotes).toBeUndefined();
    expect(result.items[0].text).toBeUndefined();
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
