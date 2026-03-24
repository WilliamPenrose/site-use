// src/storage/ingest.ts
import type { DatabaseSync } from 'node:sqlite';
import type { IngestItem, IngestResult } from './types.js';

export function ingest(db: DatabaseSync, items: IngestItem[]): IngestResult {
  let inserted = 0;
  let duplicates = 0;
  const insertedTimestamps: string[] = [];

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO items (id, site, text, author, timestamp, url, raw_json, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTwitterMeta = db.prepare(`
    INSERT OR IGNORE INTO twitter_meta (item_id, site, likes, retweets, replies, views, bookmarks, quotes, is_retweet, is_ad)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO item_mentions (site, item_id, handle) VALUES (?, ?, ?)
  `);

  const insertHashtag = db.prepare(`
    INSERT OR IGNORE INTO item_hashtags (site, item_id, tag) VALUES (?, ?, ?)
  `);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO item_links (site, item_id, url) VALUES (?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO items_fts (text, id, site, author, timestamp) VALUES (?, ?, ?, ?, ?)
  `);

  const beginTx = db.prepare('BEGIN');
  const commitTx = db.prepare('COMMIT');

  const batchTimestamp = new Date().toISOString();

  beginTx.run();
  try {
    for (const item of items) {
      const result = insertItem.run(item.id, item.site, item.text, item.author, item.timestamp, item.url, item.rawJson, batchTimestamp);

      if (result.changes > 0) {
        inserted++;
        insertedTimestamps.push(item.timestamp);

        // FTS
        insertFts.run(item.text, item.id, item.site, item.author, item.timestamp);

        // Site-specific meta (twitter)
        if (item.site === 'twitter' && item.siteMeta) {
          const m = item.siteMeta as Record<string, unknown>;
          insertTwitterMeta.run(
            item.id, item.site,
            (m.likes as number | null) ?? null,
            (m.retweets as number | null) ?? null,
            (m.replies as number | null) ?? null,
            (m.views as number | null) ?? null,
            (m.bookmarks as number | null) ?? null,
            (m.quotes as number | null) ?? null,
            m.isRetweet ? 1 : 0,
            m.isAd ? 1 : 0,
          );
        }

        // Mentions
        if (item.mentions) {
          for (const handle of item.mentions) {
            insertMention.run(item.site, item.id, handle);
          }
        }

        // Hashtags
        if (item.hashtags) {
          for (const tag of item.hashtags) {
            insertHashtag.run(item.site, item.id, tag);
          }
        }

        // Links
        if (item.links) {
          for (const linkUrl of item.links) {
            insertLink.run(item.site, item.id, linkUrl);
          }
        }
      } else {
        duplicates++;
      }
    }
    commitTx.run();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  let timeRange: { from: string; to: string } | undefined;
  if (insertedTimestamps.length > 0) {
    insertedTimestamps.sort();
    timeRange = {
      from: insertedTimestamps[0],
      to: insertedTimestamps[insertedTimestamps.length - 1],
    };
  }

  return { inserted, duplicates, timeRange };
}
