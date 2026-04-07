#!/usr/bin/env node
// scripts/migrate-source-tab.mjs
//
// One-time sidecar migration: move legacy source_tab rows from item_metrics
// into the new item_source_tabs junction table.
//
// Idempotent: safe to run multiple times. After the first successful run,
// subsequent runs are no-ops because the SELECT yields zero rows.
//
// This script is intentionally isolated from src/ — it imports nothing from
// the main codebase. It only depends on node:sqlite (Node 22+ built-in).
//
// Usage:
//   node scripts/migrate-source-tab.mjs
//   SITE_USE_DATA_DIR=/custom/path node scripts/migrate-source-tab.mjs

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const dataDir = process.env.SITE_USE_DATA_DIR
  ?? path.join(os.homedir(), '.site-use');
const dbPath = path.join(dataDir, 'data', 'knowledge.db');

console.log(`[migrate-source-tab] DB: ${dbPath}`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Defensive: ensure the new table exists, in case this script is run before
// the user has booted the new code at least once.
db.exec(`
  CREATE TABLE IF NOT EXISTS item_source_tabs (
    site    TEXT NOT NULL,
    item_id TEXT NOT NULL,
    tab     TEXT NOT NULL,
    PRIMARY KEY (site, item_id, tab),
    FOREIGN KEY (site, item_id) REFERENCES items(site, id)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_source_tabs_lookup ON item_source_tabs(site, tab)');

// Count what we're about to migrate
const beforeRow = db.prepare(
  "SELECT COUNT(*) AS n FROM item_metrics WHERE metric='source_tab' AND str_value IS NOT NULL"
).get();
const before = beforeRow ? beforeRow.n : 0;

if (before === 0) {
  console.log('[migrate-source-tab] No legacy rows to migrate. Done.');
  db.close();
  process.exit(0);
}

console.log(`[migrate-source-tab] Found ${before} legacy source_tab rows. Migrating...`);

db.exec('BEGIN');
try {
  db.exec(`
    INSERT OR IGNORE INTO item_source_tabs (site, item_id, tab)
    SELECT site, item_id, str_value
    FROM item_metrics
    WHERE metric='source_tab' AND str_value IS NOT NULL
  `);

  const insertedRow = db.prepare('SELECT COUNT(*) AS n FROM item_source_tabs').get();
  const inserted = insertedRow ? insertedRow.n : 0;

  db.exec("DELETE FROM item_metrics WHERE metric='source_tab'");
  db.exec('COMMIT');

  console.log(`[migrate-source-tab] Inserted ${inserted} unique (item, tab) pairs into item_source_tabs.`);
  console.log(`[migrate-source-tab] Removed ${before} legacy rows from item_metrics.`);
  console.log('[migrate-source-tab] Migration complete.');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('[migrate-source-tab] Migration failed, rolled back:', err);
  process.exit(1);
} finally {
  db.close();
}
