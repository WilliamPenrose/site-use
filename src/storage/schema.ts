// src/storage/schema.ts
import { DatabaseSync } from 'node:sqlite';

export function initializeDatabase(dbPath: string): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS twitter_meta (
      item_id     TEXT NOT NULL,
      site        TEXT NOT NULL DEFAULT 'twitter',
      likes       INTEGER,
      retweets    INTEGER,
      replies     INTEGER,
      views       INTEGER,
      bookmarks   INTEGER,
      quotes      INTEGER,
      is_retweet  INTEGER NOT NULL DEFAULT 0,
      is_ad       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, item_id),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS item_links (
      site    TEXT NOT NULL,
      item_id TEXT NOT NULL,
      url     TEXT NOT NULL,
      PRIMARY KEY (site, item_id, url),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_url ON item_links(url)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS item_media (
      site     TEXT    NOT NULL,
      item_id  TEXT    NOT NULL,
      type     TEXT    NOT NULL,
      url      TEXT    NOT NULL,
      width    INTEGER NOT NULL DEFAULT 0,
      height   INTEGER NOT NULL DEFAULT 0,
      duration INTEGER,
      PRIMARY KEY (site, item_id, url),
      FOREIGN KEY (site, item_id) REFERENCES items(site, id)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text,
      id UNINDEXED,
      site UNINDEXED,
      author UNINDEXED,
      timestamp UNINDEXED
    )
  `);

  return db;
}
