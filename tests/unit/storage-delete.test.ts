import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/storage/schema.js';
import { ingest } from '../../src/storage/ingest.js';
import { deleteItems, previewDelete, exportItems } from '../../src/storage/delete.js';
import type { IngestItem, DeleteProgress } from '../../src/storage/types.js';

function makeItem(overrides: Partial<IngestItem> = {}): IngestItem {
  return {
    site: 'twitter',
    id: '1',
    text: 'Hello world',
    author: 'alice',
    timestamp: '2026-03-20T10:00:00Z',
    url: 'https://x.com/alice/status/1',
    rawJson: JSON.stringify({ author: { handle: 'alice', following: true }, text: 'Hello world' }),
    mentions: ['bob'],
    hashtags: ['test'],
    metrics: [
      { metric: 'likes', numValue: 100 },
      { metric: 'following', numValue: 1 },
    ],
    ...overrides,
  };
}

let db: DatabaseSync;

afterEach(() => {
  db.close();
});

beforeEach(() => {
  db = initializeDatabase(':memory:');
  ingest(db, [
    makeItem({ id: '1', author: 'alice', timestamp: '2026-03-01T10:00:00Z' }),
    makeItem({ id: '2', author: 'alice', timestamp: '2026-03-10T10:00:00Z' }),
    makeItem({ id: '3', author: 'bob', timestamp: '2026-03-15T10:00:00Z' }),
    makeItem({ id: '4', author: 'bob', timestamp: '2026-03-20T10:00:00Z' }),
    makeItem({ id: '5', author: 'charlie', timestamp: '2026-03-25T10:00:00Z' }),
  ]);
});

describe('previewDelete', () => {
  it('previews by before filter', () => {
    const preview = previewDelete(db, { site: 'twitter', before: '2026-03-11T00:00:00Z' });
    expect(preview.totalCount).toBe(2);
    expect(preview.authors).toEqual([{ handle: 'alice', count: 2 }]);
    expect(preview.timeRange).toEqual({
      from: '2026-03-01T10:00:00Z',
      to: '2026-03-10T10:00:00Z',
    });
  });

  it('previews by after filter', () => {
    const preview = previewDelete(db, { site: 'twitter', after: '2026-03-20T00:00:00Z' });
    expect(preview.totalCount).toBe(2);
  });

  it('previews by author filter', () => {
    const preview = previewDelete(db, { site: 'twitter', author: 'bob' });
    expect(preview.totalCount).toBe(2);
    expect(preview.authors).toEqual([{ handle: 'bob', count: 2 }]);
  });

  it('previews with combined filters', () => {
    const preview = previewDelete(db, { site: 'twitter', author: 'bob', before: '2026-03-18T00:00:00Z' });
    expect(preview.totalCount).toBe(1);
  });

  it('previews by ingestedBefore filter', () => {
    const all = previewDelete(db, { site: 'twitter', ingestedBefore: '2099-01-01T00:00:00Z' });
    expect(all.totalCount).toBe(5);
    const none = previewDelete(db, { site: 'twitter', ingestedBefore: '2000-01-01T00:00:00Z' });
    expect(none.totalCount).toBe(0);
  });

  it('previews by ingestedAfter filter', () => {
    const all = previewDelete(db, { site: 'twitter', ingestedAfter: '2000-01-01T00:00:00Z' });
    expect(all.totalCount).toBe(5);
    const none = previewDelete(db, { site: 'twitter', ingestedAfter: '2099-01-01T00:00:00Z' });
    expect(none.totalCount).toBe(0);
  });

  it('returns zero count when nothing matches', () => {
    const preview = previewDelete(db, { site: 'twitter', author: 'nobody' });
    expect(preview.totalCount).toBe(0);
    expect(preview.authors).toEqual([]);
    expect(preview.timeRange).toBeNull();
  });
});

describe('exportItems', () => {
  it('exports matching items as JSONL lines', () => {
    const lines: string[] = [];
    exportItems(db, { site: 'twitter', before: '2026-03-11T00:00:00Z' }, (line) => lines.push(line));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('raw_json');
      expect(parsed).toHaveProperty('ingested_at');
    }
  });

  it('exports nothing when no match', () => {
    const lines: string[] = [];
    exportItems(db, { site: 'twitter', author: 'nobody' }, (line) => lines.push(line));
    expect(lines.length).toBe(0);
  });
});

describe('deleteItems', () => {
  it('deletes matching items and cascades to all related tables', () => {
    const result = deleteItems(db, { site: 'twitter', before: '2026-03-11T00:00:00Z' });
    expect(result.deleted).toBe(2);

    const remaining = db.prepare('SELECT id FROM items WHERE site = ?').all('twitter') as Array<{ id: string }>;
    expect(remaining.map(r => r.id).sort()).toEqual(['3', '4', '5']);

    const metricCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM item_metrics WHERE site = 'twitter' AND item_id IN ('1', '2')"
    ).get() as { cnt: number }).cnt;
    expect(metricCount).toBe(0);

    const mentionCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM item_mentions WHERE site = 'twitter' AND item_id IN ('1', '2')"
    ).get() as { cnt: number }).cnt;
    expect(mentionCount).toBe(0);

    const hashtagCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM item_hashtags WHERE site = 'twitter' AND item_id IN ('1', '2')"
    ).get() as { cnt: number }).cnt;
    expect(hashtagCount).toBe(0);

    // FTS5: UNINDEXED columns can't filter, so count all remaining rows
    const ftsTotal = (db.prepare(
      "SELECT COUNT(*) as cnt FROM items_fts"
    ).get() as { cnt: number }).cnt;
    expect(ftsTotal).toBe(3);
  });

  it('deletes by author', () => {
    const result = deleteItems(db, { site: 'twitter', author: 'alice' });
    expect(result.deleted).toBe(2);
  });

  it('deletes nothing when no match', () => {
    const result = deleteItems(db, { site: 'twitter', author: 'nobody' });
    expect(result.deleted).toBe(0);
  });

  it('does not affect other sites', () => {
    ingest(db, [makeItem({ site: 'reddit', id: 'r1', timestamp: '2026-03-01T10:00:00Z' })]);
    deleteItems(db, { site: 'twitter', before: '2026-03-30T00:00:00Z' });
    const remaining = (db.prepare("SELECT COUNT(*) as cnt FROM items WHERE site = 'reddit'").get() as { cnt: number }).cnt;
    expect(remaining).toBe(1);
  });

  it('processes in batches and fires progress callback', () => {
    const progressUpdates: DeleteProgress[] = [];
    deleteItems(db, { site: 'twitter', before: '2026-03-30T00:00:00Z' }, {
      batchSize: 2,
      onProgress: (p) => progressUpdates.push({ ...p }),
    });

    // 5 items / batch 2 = 3 batches (2, 2, 1)
    expect(progressUpdates.length).toBe(3);
    expect(progressUpdates[0]).toEqual({ deletedSoFar: 2, totalCount: 5 });
    expect(progressUpdates[1]).toEqual({ deletedSoFar: 4, totalCount: 5 });
    expect(progressUpdates[2]).toEqual({ deletedSoFar: 5, totalCount: 5 });

    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM items').get() as { cnt: number }).cnt;
    expect(remaining).toBe(0);
  });
});
