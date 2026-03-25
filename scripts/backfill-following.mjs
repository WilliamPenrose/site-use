// One-time migration: backfill 'following' metric for existing twitter items.
// Run: node scripts/backfill-following.mjs
// Delete this script after running.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
const dbPath = path.join(dataDir, 'data', 'knowledge.db');

if (!fs.existsSync(dbPath)) {
  console.log('No database found at', dbPath);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);

// Find twitter items missing 'following' metric
const rows = db.prepare(`
  SELECT i.id, i.site, i.raw_json
  FROM items i
  WHERE i.site = 'twitter'
    AND NOT EXISTS (
      SELECT 1 FROM item_metrics m
      WHERE m.site = i.site AND m.item_id = i.id AND m.metric = 'following'
    )
`).all();

console.log(`Found ${rows.length} items to backfill`);

const insert = db.prepare(
  'INSERT INTO item_metrics (site, item_id, metric, num_value) VALUES (?, ?, ?, ?)'
);

let count = 0;
for (const row of rows) {
  try {
    const tweet = JSON.parse(row.raw_json);
    const following = tweet.author?.following ? 1 : 0;
    insert.run(row.site, row.id, 'following', following);
    count++;
  } catch (e) {
    console.warn(`Skipped ${row.id}: ${e.message}`);
  }
}

db.close();
console.log(`Backfilled ${count} items`);
