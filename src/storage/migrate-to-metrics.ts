// src/storage/migrate-to-metrics.ts
//
// One-time migration: twitter_meta → item_metrics + FTS rebuild.
// Safe to run multiple times (idempotent via INSERT OR IGNORE).
//
// Usage: npx tsx src/storage/migrate-to-metrics.ts [db-path]
//        Defaults to ~/.site-use/data/knowledge.db

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { getKnowledgeDbPath } from '../config.js';
import os from 'node:os';

function migrate(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Step 1: Create item_metrics if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_metrics (
      site       TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      metric     TEXT NOT NULL,
      num_value  INTEGER,
      real_value REAL,
      str_value  TEXT,
      PRIMARY KEY (site, item_id, metric),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_metrics_num ON item_metrics(site, metric, num_value)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_metrics_real ON item_metrics(site, metric, real_value)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_metrics_str ON item_metrics(site, metric, str_value)');

  // Step 2: Backfill metrics from raw_json
  const metricPaths = [
    { metric: 'likes', jsonPath: '$.metrics.likes' },
    { metric: 'retweets', jsonPath: '$.metrics.retweets' },
    { metric: 'replies', jsonPath: '$.metrics.replies' },
    { metric: 'views', jsonPath: '$.metrics.views' },
    { metric: 'bookmarks', jsonPath: '$.metrics.bookmarks' },
    { metric: 'quotes', jsonPath: '$.metrics.quotes' },
  ];

  let totalMetrics = 0;
  for (const { metric, jsonPath } of metricPaths) {
    db.exec(`
      INSERT OR IGNORE INTO item_metrics (site, item_id, metric, num_value)
      SELECT site, id, '${metric}', json_extract(raw_json, '${jsonPath}')
      FROM items
      WHERE json_extract(raw_json, '${jsonPath}') IS NOT NULL
    `);
    const { cnt } = db.prepare(
      "SELECT COUNT(*) as cnt FROM item_metrics WHERE metric = ?",
    ).get(metric) as { cnt: number };
    totalMetrics += cnt;
    console.log(`  ${metric}: ${cnt} rows`);
  }
  console.log(`Backfilled ${totalMetrics} metric rows total.`);

  // Step 3: Rebuild FTS index (schema changed — removed author/timestamp columns)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items_fts'").all();
  if (tables.length > 0) {
    console.log('Rebuilding FTS index (removing author/timestamp columns)...');
    db.exec('DROP TABLE items_fts');
  }
  db.exec(`
    CREATE VIRTUAL TABLE items_fts USING fts5(
      text,
      id UNINDEXED,
      site UNINDEXED
    )
  `);
  db.exec(`
    INSERT INTO items_fts (text, id, site)
    SELECT text, id, site FROM items
  `);
  const { ftsCount } = db.prepare('SELECT COUNT(*) as ftsCount FROM items_fts').get() as { ftsCount: number };
  console.log(`Rebuilt FTS index: ${ftsCount} rows.`);

  // Step 4: Drop old tables
  const oldTables = ['twitter_meta', 'item_links', 'item_media'];
  for (const table of oldTables) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table);
    if (exists.length > 0) {
      db.exec(`DROP TABLE ${table}`);
      console.log(`Dropped table: ${table}`);
    }
  }

  db.close();
  console.log('Migration complete.');
}

// CLI entry point
const defaultDataDir = path.join(os.homedir(), '.site-use');
const dbPath = process.argv[2] || getKnowledgeDbPath(defaultDataDir);
console.log(`Migrating database: ${dbPath}`);
migrate(dbPath);
