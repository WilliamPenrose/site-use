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

  const insertMetric = db.prepare(`
    INSERT OR IGNORE INTO item_metrics (site, item_id, metric, num_value, real_value, str_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO item_mentions (site, item_id, handle) VALUES (?, ?, ?)
  `);

  const insertHashtag = db.prepare(`
    INSERT OR IGNORE INTO item_hashtags (site, item_id, tag) VALUES (?, ?, ?)
  `);

  const insertSourceTab = db.prepare(`
    INSERT OR IGNORE INTO item_source_tabs (site, item_id, tab) VALUES (?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO items_fts (text, id, site) VALUES (?, ?, ?)
  `);

  const beginTx = db.prepare('BEGIN');
  const commitTx = db.prepare('COMMIT');

  const batchTimestamp = new Date().toISOString();

  beginTx.run();
  try {
    for (const item of items) {
      const result = insertItem.run(
        item.id, item.site, item.text, item.author,
        item.timestamp, item.url, item.rawJson, batchTimestamp,
      );

      if (result.changes > 0) {
        inserted++;
        insertedTimestamps.push(item.timestamp);

        // FTS
        insertFts.run(item.text, item.id, item.site);

        // Metrics — generic KV, site-agnostic
        for (const m of item.metrics ?? []) {
          insertMetric.run(
            item.site, item.id, m.metric,
            m.numValue ?? null, m.realValue ?? null, m.strValue ?? null,
          );
        }

        // Mentions
        for (const handle of item.mentions ?? []) {
          insertMention.run(item.site, item.id, handle);
        }

        // Hashtags
        for (const tag of item.hashtags ?? []) {
          insertHashtag.run(item.site, item.id, tag);
        }
      } else {
        duplicates++;
      }

      // Source tabs — always attempted, even on duplicate items.
      // PK (site, item_id, tab) + INSERT OR IGNORE makes this idempotent.
      // This allows the same item to be linked to additional tabs across re-ingests.
      for (const tab of item.sourceTabs ?? []) {
        insertSourceTab.run(item.site, item.id, tab);
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
