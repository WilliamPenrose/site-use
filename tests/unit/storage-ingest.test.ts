// tests/unit/storage-ingest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/storage/schema.js';
import { ingest } from '../../src/storage/ingest.js';
import type { IngestItem } from '../../src/storage/types.js';

function makeItem(overrides: Partial<IngestItem> = {}): IngestItem {
  return {
    site: 'twitter',
    id: '123456',
    text: 'Hello world @someone #testing',
    author: 'testuser',
    timestamp: '2026-03-20T10:00:00Z',
    url: 'https://x.com/testuser/status/123456',
    rawJson: '{"full": "data"}',
    mentions: ['someone'],
    hashtags: ['testing'],
    siteMeta: { likes: 42, retweets: 5, replies: 3, views: 1000, bookmarks: 1, quotes: 0, isRetweet: false, isAd: false },
    ...overrides,
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = initializeDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('ingest', () => {
  it('inserts a new item and returns inserted=1', () => {
    const result = ingest(db, [makeItem()]);
    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(0);
  });

  it('deduplicates by (site, id) — second insert returns duplicates=1', () => {
    ingest(db, [makeItem()]);
    const result = ingest(db, [makeItem()]);
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  it('writes twitter_meta for new items', () => {
    ingest(db, [makeItem()]);
    const row = db.prepare('SELECT likes, retweets, is_retweet FROM twitter_meta WHERE item_id = ?').get('123456') as any;
    expect(row.likes).toBe(42);
    expect(row.retweets).toBe(5);
    expect(row.is_retweet).toBe(0);
  });

  it('writes mentions to item_mentions', () => {
    ingest(db, [makeItem()]);
    const rows = db.prepare('SELECT handle FROM item_mentions WHERE item_id = ?').all('123456') as any[];
    expect(rows.map((r: any) => r.handle)).toEqual(['someone']);
  });

  it('writes hashtags to item_hashtags', () => {
    ingest(db, [makeItem()]);
    const rows = db.prepare('SELECT tag FROM item_hashtags WHERE item_id = ?').all('123456') as any[];
    expect(rows.map((r: any) => r.tag)).toEqual(['testing']);
  });

  it('does not create duplicate FTS rows on re-ingest', () => {
    ingest(db, [makeItem()]);
    ingest(db, [makeItem()]);
    const count = db.prepare("SELECT COUNT(*) as cnt FROM items_fts WHERE items_fts MATCH 'world'").get() as any;
    expect(count.cnt).toBe(1);
  });

  it('returns timeRange spanning newly inserted items', () => {
    const items = [
      makeItem({ id: '1', timestamp: '2026-03-20T08:00:00Z' }),
      makeItem({ id: '2', timestamp: '2026-03-20T12:00:00Z' }),
    ];
    const result = ingest(db, items);
    expect(result.timeRange).toEqual({
      from: '2026-03-20T08:00:00Z',
      to: '2026-03-20T12:00:00Z',
    });
  });

  it('returns no timeRange when all items are duplicates', () => {
    ingest(db, [makeItem()]);
    const result = ingest(db, [makeItem()]);
    expect(result.timeRange).toBeUndefined();
  });
});
