#!/usr/bin/env node
// scripts/migrate-tab-canonical.mjs
//
// One-time sidecar migration: collapse non-canonical tab strings in
// item_source_tabs and fetch-timestamps.json into their canonical form.
//
// Background: prior to canonicalization, the same tab could be stored under
// multiple casing/spacing variants (e.g. "Following" and "following"), causing
// `--tab Following` and `--tab following` to miss each other's cache and split
// `lastCollected` stats. See issue #11.
//
// Idempotent: safe to run multiple times. After the first successful run, all
// rows are already canonical and the script is a no-op.
//
// This script is intentionally isolated from src/ — it imports nothing from
// the main codebase. It only depends on node:sqlite (Node 22+ built-in) and
// node:fs.
//
// Usage:
//   node scripts/migrate-tab-canonical.mjs
//   SITE_USE_DATA_DIR=/custom/path node scripts/migrate-tab-canonical.mjs

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mirror of src/sites/twitter/canonicalize.ts. Kept inline so this script
// stays independent of the build output.
function canonicalizeTab(raw) {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '_');
}

const dataDir = process.env.SITE_USE_DATA_DIR
  ?? path.join(os.homedir(), '.site-use');
const dbPath = path.join(dataDir, 'data', 'knowledge.db');
const tsPath = path.join(dataDir, 'fetch-timestamps.json');

console.log(`[migrate-tab-canonical] DB:        ${dbPath}`);
console.log(`[migrate-tab-canonical] TS file:   ${tsPath}`);

// ── 1. item_source_tabs ──────────────────────────────────────────────
let dbMerged = 0;
let dbRemoved = 0;
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Defensive: nothing to do if the table doesn't exist yet.
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_source_tabs'"
  ).get();

  if (tableExists) {
    const rows = db.prepare(
      'SELECT site, item_id, tab FROM item_source_tabs'
    ).all();

    const noncanonical = rows.filter(r => canonicalizeTab(r.tab) !== r.tab);

    if (noncanonical.length === 0) {
      console.log('[migrate-tab-canonical] item_source_tabs already canonical. Skipping.');
    } else {
      console.log(`[migrate-tab-canonical] Found ${noncanonical.length} non-canonical rows in item_source_tabs.`);

      db.exec('BEGIN');
      try {
        const insert = db.prepare(
          'INSERT OR IGNORE INTO item_source_tabs (site, item_id, tab) VALUES (?, ?, ?)'
        );
        const del = db.prepare(
          'DELETE FROM item_source_tabs WHERE site = ? AND item_id = ? AND tab = ?'
        );

        for (const r of noncanonical) {
          const canonical = canonicalizeTab(r.tab);
          insert.run(r.site, r.item_id, canonical);
          del.run(r.site, r.item_id, r.tab);
          dbMerged++;
        }
        dbRemoved = dbMerged;
        db.exec('COMMIT');
        console.log(`[migrate-tab-canonical] Merged ${dbMerged} rows into canonical form.`);
      } catch (err) {
        db.exec('ROLLBACK');
        console.error('[migrate-tab-canonical] DB migration failed, rolled back:', err);
        process.exit(1);
      }
    }
  } else {
    console.log('[migrate-tab-canonical] item_source_tabs table not present. Skipping DB step.');
  }
  db.close();
} else {
  console.log('[migrate-tab-canonical] DB file not found. Skipping DB step.');
}

// ── 2. fetch-timestamps.json ─────────────────────────────────────────
let tsMerged = 0;
if (fs.existsSync(tsPath)) {
  const raw = fs.readFileSync(tsPath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('[migrate-tab-canonical] Could not parse fetch-timestamps.json:', err);
    process.exit(1);
  }

  let mutated = false;
  for (const site of Object.keys(data)) {
    const variants = data[site];
    if (!variants || typeof variants !== 'object') continue;

    const collapsed = {};
    for (const [variant, ts] of Object.entries(variants)) {
      const canonical = canonicalizeTab(variant);
      const existing = collapsed[canonical];
      // Keep the most recent timestamp on collision.
      if (!existing || (typeof ts === 'string' && ts > existing)) {
        collapsed[canonical] = ts;
      }
      if (canonical !== variant) {
        mutated = true;
        tsMerged++;
      }
    }
    data[site] = collapsed;
  }

  if (mutated) {
    fs.writeFileSync(tsPath, JSON.stringify(data, null, 2));
    console.log(`[migrate-tab-canonical] Collapsed ${tsMerged} variants in fetch-timestamps.json.`);
  } else {
    console.log('[migrate-tab-canonical] fetch-timestamps.json already canonical. Skipping.');
  }
} else {
  console.log('[migrate-tab-canonical] fetch-timestamps.json not found. Skipping TS step.');
}

console.log('[migrate-tab-canonical] Migration complete.');
