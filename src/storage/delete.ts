// src/storage/delete.ts
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteParams, DeletePreview, DeleteResult, DeleteOptions } from './types.js';

type SqlValue = null | number | bigint | string;

const DEFAULT_BATCH_SIZE = 500;

function buildWhereClause(params: DeleteParams): { where: string; values: SqlValue[] } {
  const conditions: string[] = ['site = ?'];
  const values: SqlValue[] = [params.site];

  if (params.before) {
    conditions.push('timestamp < ?');
    values.push(params.before);
  }
  if (params.after) {
    conditions.push('timestamp >= ?');
    values.push(params.after);
  }
  if (params.ingestedBefore) {
    conditions.push('ingested_at < ?');
    values.push(params.ingestedBefore);
  }
  if (params.ingestedAfter) {
    conditions.push('ingested_at >= ?');
    values.push(params.ingestedAfter);
  }
  if (params.author) {
    conditions.push('author = ?');
    values.push(params.author);
  }

  return { where: conditions.join(' AND '), values };
}

export function previewDelete(db: DatabaseSync, params: DeleteParams): DeletePreview {
  const { where, values } = buildWhereClause(params);

  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM items WHERE ${where}`,
  ).get(...values) as { cnt: number };
  if (countRow.cnt === 0) {
    return { totalCount: 0, authors: [], timeRange: null };
  }

  const authorRows = db.prepare(
    `SELECT author as handle, COUNT(*) as count FROM items WHERE ${where} GROUP BY author ORDER BY count DESC`,
  ).all(...values) as Array<{ handle: string; count: number }>;

  const rangeRow = db.prepare(
    `SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM items WHERE ${where}`,
  ).get(...values) as { min_ts: string; max_ts: string };

  return {
    totalCount: countRow.cnt,
    authors: authorRows,
    timeRange: { from: rangeRow.min_ts, to: rangeRow.max_ts },
  };
}

export function exportItems(
  db: DatabaseSync,
  params: DeleteParams,
  onLine: (line: string) => void,
): void {
  const { where, values } = buildWhereClause(params);
  const rows = db.prepare(
    `SELECT id, site, author, timestamp, ingested_at, raw_json FROM items WHERE ${where} ORDER BY timestamp`,
  ).all(...values) as Array<{
    id: string; site: string; author: string;
    timestamp: string; ingested_at: string; raw_json: string;
  }>;

  for (const row of rows) {
    onLine(JSON.stringify({
      id: row.id,
      site: row.site,
      author: row.author,
      timestamp: row.timestamp,
      ingested_at: row.ingested_at,
      raw_json: row.raw_json,
    }));
  }
}

export function deleteItems(
  db: DatabaseSync,
  params: DeleteParams,
  opts: DeleteOptions = {},
): DeleteResult {
  const { where, values } = buildWhereClause(params);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const totalRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM items WHERE ${where}`,
  ).get(...values) as { cnt: number };
  if (totalRow.cnt === 0) return { deleted: 0 };
  const totalCount = totalRow.cnt;

  let deletedSoFar = 0;

  const beginTx = db.prepare('BEGIN');
  const commitTx = db.prepare('COMMIT');
  const ftsFindRowid = db.prepare('SELECT rowid FROM items_fts WHERE id = ? AND site = ?');
  const ftsDelete = db.prepare('DELETE FROM items_fts WHERE rowid = ?');

  while (true) {
    const batch = db.prepare(
      `SELECT id FROM items WHERE ${where} LIMIT ?`,
    ).all(...values, batchSize) as Array<{ id: string }>;

    if (batch.length === 0) break;

    const ids = batch.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const site = params.site;

    beginTx.run();
    try {
      db.prepare(`DELETE FROM item_metrics WHERE site = ? AND item_id IN (${placeholders})`).run(site, ...ids);
      db.prepare(`DELETE FROM item_mentions WHERE site = ? AND item_id IN (${placeholders})`).run(site, ...ids);
      db.prepare(`DELETE FROM item_hashtags WHERE site = ? AND item_id IN (${placeholders})`).run(site, ...ids);
      db.prepare(`DELETE FROM item_source_tabs WHERE site = ? AND item_id IN (${placeholders})`).run(site, ...ids);

      // For standalone FTS5 tables, delete by rowid
      for (const row of batch) {
        const ftsRow = ftsFindRowid.get(row.id, site) as { rowid: number } | undefined;
        if (ftsRow) {
          ftsDelete.run(ftsRow.rowid);
        }
      }

      db.prepare(`DELETE FROM items WHERE site = ? AND id IN (${placeholders})`).run(site, ...ids);
      commitTx.run();
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    deletedSoFar += batch.length;
    opts.onProgress?.({ deletedSoFar, totalCount });
  }

  return { deleted: deletedSoFar };
}
