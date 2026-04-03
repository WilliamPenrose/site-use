// src/storage/schema.ts
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function initializeDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id              TEXT NOT NULL,
      site            TEXT NOT NULL,
      text            TEXT NOT NULL,
      author          TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      url             TEXT NOT NULL,
      raw_json        TEXT NOT NULL,
      embedding_model TEXT,
      ingested_at     TEXT NOT NULL,
      PRIMARY KEY (site, id)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_items_author ON items(site, author)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(site, timestamp)');

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS item_mentions (
      site    TEXT NOT NULL,
      item_id TEXT NOT NULL,
      handle  TEXT NOT NULL,
      PRIMARY KEY (site, item_id, handle),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mentions_handle ON item_mentions(handle)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS item_hashtags (
      site    TEXT NOT NULL,
      item_id TEXT NOT NULL,
      tag     TEXT NOT NULL,
      PRIMARY KEY (site, item_id, tag),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON item_hashtags(tag)');

  // FTS5 with trigram tokenizer — supports CJK (no whitespace delimiters)
  // and Latin text. Trigram requires queries >= 3 chars; shorter queries
  // must use LIKE fallback in query.ts.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text,
      id UNINDEXED,
      site UNINDEXED,
      tokenize='trigram'
    )
  `);

  // Auto-migrate: if existing FTS index doesn't use trigram, rebuild it
  try {
    const ftsInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='items_fts'"
    ).get() as { sql: string } | undefined;
    if (ftsInfo && !ftsInfo.sql.includes('trigram')) {
      db.exec('DROP TABLE items_fts');
      db.exec(`
        CREATE VIRTUAL TABLE items_fts USING fts5(
          text,
          id UNINDEXED,
          site UNINDEXED,
          tokenize='trigram'
        )
      `);
      db.exec(`
        INSERT INTO items_fts (text, id, site)
        SELECT text, id, site FROM items
      `);
    }
  } catch {
    // FTS table doesn't exist yet or migration not needed — ok
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS action_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      site         TEXT NOT NULL,
      action       TEXT NOT NULL,
      target       TEXT NOT NULL,
      success      INTEGER NOT NULL,
      prev_state   TEXT,
      result_state TEXT,
      timestamp    TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_action_log_daily ON action_log(site, action, timestamp)');

  return db;
}
