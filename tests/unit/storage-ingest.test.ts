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
    rawJson: JSON.stringify({
      author: { handle: 'testuser', name: 'Test User', following: true },
      text: 'Hello world @someone #testing',
      metrics: { likes: 42, retweets: 5 },
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg', width: 1920, height: 1080 }],
      links: ['https://example.com/article'],
    }),
    mentions: ['someone'],
    hashtags: ['testing'],
    metrics: [
      { metric: 'likes', numValue: 42 },
      { metric: 'retweets', numValue: 5 },
      { metric: 'replies', numValue: 3 },
      { metric: 'views', numValue: 1000 },
    ],
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

  it('writes metrics to item_metrics', () => {
    ingest(db, [makeItem()]);
    const rows = db.prepare(
      "SELECT metric, num_value FROM item_metrics WHERE item_id = ? ORDER BY metric",
    ).all('123456') as Array<{ metric: string; num_value: number }>;
    expect(rows).toEqual([
      { metric: 'likes', num_value: 42 },
      { metric: 'replies', num_value: 3 },
      { metric: 'retweets', num_value: 5 },
      { metric: 'views', num_value: 1000 },
    ]);
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

  it('handles items with no metrics', () => {
    const result = ingest(db, [makeItem({ metrics: undefined })]);
    expect(result.inserted).toBe(1);
    const rows = db.prepare('SELECT COUNT(*) as cnt FROM item_metrics WHERE item_id = ?').get('123456') as any;
    expect(rows.cnt).toBe(0);
  });

  it('handles string-valued metrics', () => {
    ingest(db, [makeItem({
      id: 'str1',
      metrics: [{ metric: 'subreddit', strValue: 'programming' }],
    })]);
    const row = db.prepare(
      "SELECT str_value FROM item_metrics WHERE item_id = ? AND metric = 'subreddit'",
    ).get('str1') as any;
    expect(row.str_value).toBe('programming');
  });
});
