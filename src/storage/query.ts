// src/storage/query.ts
import type { DatabaseSync } from 'node:sqlite';
import type { SearchParams, SearchResult, SearchResultItem, StoreStats } from './types.js';

type SqlValue = null | number | bigint | string;

export function search(db: DatabaseSync, params: SearchParams): SearchResult {
  const conditions: string[] = [];
  const joins: string[] = [];
  const values: SqlValue[] = [];
  const limit = params.limit ?? 20;

  // FTS join — id+site columns stored in FTS table (rowids are independent from items)
  if (params.query) {
    joins.push('JOIN items_fts fts ON fts.id = i.id AND fts.site = i.site');
    conditions.push('items_fts MATCH ?');
    values.push(params.query);
  }

  if (params.site) {
    conditions.push('i.site = ?');
    values.push(params.site);
  }

  if (params.author) {
    conditions.push('i.author = ?');
    values.push(params.author);
  }

  if (params.since) {
    conditions.push('i.timestamp >= ?');
    values.push(params.since);
  }

  if (params.until) {
    conditions.push('i.timestamp < ?');
    values.push(params.until);
  }

  // Site-specific filters
  let tmJoined = false;
  if (params.siteFilters) {
    if (params.siteFilters.hashtag) {
      joins.push('JOIN item_hashtags h ON h.site = i.site AND h.item_id = i.id');
      conditions.push('h.tag = ?');
      values.push(params.siteFilters.hashtag as string);
    }
    if (params.siteFilters.minLikes != null) {
      joins.push('JOIN twitter_meta tm ON tm.site = i.site AND tm.item_id = i.id');
      tmJoined = true;
      conditions.push('tm.likes >= ?');
      values.push(params.siteFilters.minLikes as number);
    }
    if (params.siteFilters.minRetweets != null) {
      if (!tmJoined) {
        joins.push('JOIN twitter_meta tm ON tm.site = i.site AND tm.item_id = i.id');
        tmJoined = true;
      }
      conditions.push('tm.retweets >= ?');
      values.push(params.siteFilters.minRetweets as number);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const joinClause = joins.join(' ');

  // Count total matches
  const countSql = `SELECT COUNT(*) as cnt FROM items i ${joinClause} ${whereClause}`;
  const total = (db.prepare(countSql).get(...values) as { cnt: number }).cnt;

  // Fetch items
  const selectSql = `
    SELECT i.id, i.site, i.text, i.author, i.timestamp, i.url
    FROM items i ${joinClause} ${whereClause}
    ORDER BY i.timestamp DESC
    LIMIT ?
  `;

  const rows = db.prepare(selectSql).all(...values, limit) as Array<{
    id: string; site: string; text: string; author: string; timestamp: string; url: string;
  }>;

  const items: SearchResultItem[] = rows.map((row) => ({
    id: row.id,
    site: row.site,
    text: row.text,
    author: row.author,
    timestamp: row.timestamp,
    url: row.url,
  }));

  return { items, total };
}

export function stats(db: DatabaseSync): StoreStats {
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM items').get() as { cnt: number };
  const totalItems = totalRow.cnt;

  const siteRows = db.prepare('SELECT site, COUNT(*) as cnt FROM items GROUP BY site').all() as Array<{ site: string; cnt: number }>;
  const bySite: Record<string, number> = {};
  for (const row of siteRows) {
    bySite[row.site] = row.cnt;
  }

  const authorsRow = db.prepare('SELECT COUNT(DISTINCT author) as cnt FROM items').get() as { cnt: number };
  const uniqueAuthors = authorsRow.cnt;

  const rangeRow = db.prepare('SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM items').get() as { min_ts: string | null; max_ts: string | null };
  const timeRange = rangeRow.min_ts
    ? { from: rangeRow.min_ts, to: rangeRow.max_ts as string }
    : null;

  return { totalItems, bySite, uniqueAuthors, timeRange, embeddingModel: null, embeddingCoverage: 0 };
}
