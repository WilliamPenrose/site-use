// src/storage/query.ts
import type { DatabaseSync } from 'node:sqlite';
import type { SearchParams, SearchResult, SearchResultItem, CountItemsParams, SiteStats } from './types.js';
import { resolveItem } from '../display/resolve.js';
import { applyFieldsFilter } from './fields.js';
import type { DisplaySchema } from '../display/resolve.js';

type SqlValue = null | number | bigint | string;

const displaySchemas: Record<string, DisplaySchema> = {};

// Top-level fields already on SearchResultItem — exclude from siteMeta.
// Also excludes display-only formatting fields (authorTag) that should not
// leak into siteMeta output.
const TOP_LEVEL_FIELDS = new Set([
  'text', 'author', 'authorName', 'authorTag', 'timestamp', 'url', 'media', 'links',
]);

/** Register a site's display schema for search result resolution. */
export function registerDisplaySchema(site: string, schema: DisplaySchema): void {
  displaySchemas[site] = schema;
}

export function search(db: DatabaseSync, params: SearchParams): SearchResult {
  const conditions: string[] = [];
  const joins: string[] = [];
  const values: SqlValue[] = [];
  const limit = params.max_results ?? 20;

  // FTS join — trigram tokenizer requires >= 3 chars
  if (params.query) {
    if (params.query.length >= 3) {
      joins.push('JOIN items_fts fts ON fts.id = i.id AND fts.site = i.site');
      conditions.push('items_fts MATCH ?');
      values.push(params.query);
    } else {
      // Short query: LIKE fallback (trigram can't index < 3 chars)
      conditions.push('i.text LIKE ?');
      values.push(`%${params.query}%`);
    }
  }

  if (params.site) {
    conditions.push('i.site = ?');
    values.push(params.site);
  }

  if (params.author) {
    conditions.push('i.author = ?');
    values.push(params.author);
  }

  if (params.start_date) {
    conditions.push('i.timestamp >= ?');
    values.push(params.start_date);
  }

  if (params.end_date) {
    conditions.push('i.timestamp < ?');
    values.push(params.end_date);
  }

  // Multi-value filters
  if (params.hashtag) {
    joins.push('JOIN item_hashtags h ON h.site = i.site AND h.item_id = i.id');
    conditions.push('h.tag = ?');
    values.push(params.hashtag.toLowerCase().replace(/^#/, ''));
  }
  if (params.mention) {
    joins.push('JOIN item_mentions mn ON mn.site = i.site AND mn.item_id = i.id');
    conditions.push('LOWER(mn.handle) = ?');
    values.push(params.mention.toLowerCase().replace(/^@/, ''));
  }

  // Generic metric filters — each filter adds a JOIN to item_metrics
  if (params.metricFilters) {
    for (let idx = 0; idx < params.metricFilters.length; idx++) {
      const mf = params.metricFilters[idx];
      const alias = `mf${idx}`;
      joins.push(`JOIN item_metrics ${alias} ON ${alias}.site = i.site AND ${alias}.item_id = i.id`);
      conditions.push(`${alias}.metric = ?`);
      values.push(mf.metric);

      if (mf.numValue != null) {
        conditions.push(`${alias}.num_value ${mf.op} ?`);
        values.push(mf.numValue);
      } else if (mf.realValue != null) {
        conditions.push(`${alias}.real_value ${mf.op} ?`);
        values.push(mf.realValue);
      } else if (mf.strValue != null) {
        conditions.push(`${alias}.str_value ${mf.op} ?`);
        values.push(mf.strValue);
      }
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const joinClause = joins.join(' ');

  // Fetch items + raw_json for display resolution
  const selectSql = `
    SELECT i.id, i.site, i.text, i.author, i.timestamp, i.url, i.raw_json
    FROM items i ${joinClause} ${whereClause}
    ORDER BY i.timestamp DESC
    LIMIT ?
  `;

  const rows = db.prepare(selectSql).all(...values, limit) as Array<Record<string, unknown>>;

  let items: SearchResultItem[] = rows.map((row) => {
    const site = row.site as string;
    const rawJson = row.raw_json as string;
    const doc = JSON.parse(rawJson) as Record<string, unknown>;
    const schema = displaySchemas[site];

    const item: SearchResultItem = {
      id: row.id as string,
      site,
      text: row.text as string,
      author: row.author as string,
      timestamp: row.timestamp as string,
      url: row.url as string,
      rawJson,
    };

    // Resolve display-only data from raw_json via display schema
    if (schema) {
      // Collect all schema fields, split into top-level vs siteMeta
      const allFields = Object.keys(schema);
      const metaFields = allFields.filter(f => !TOP_LEVEL_FIELDS.has(f));

      // Resolve siteMeta fields
      if (metaFields.length > 0) {
        const display = resolveItem(doc, schema, metaFields);
        const meta: Record<string, unknown> = {};
        for (const field of metaFields) {
          if (display[field] != null) meta[field] = display[field];
        }
        if (Object.keys(meta).length > 0) item.siteMeta = meta;
      }

      // Resolve top-level fields that come from raw_json
      const links = resolveItem(doc, schema, ['links']).links as string[] | undefined;
      if (links) item.links = links;

      const media = resolveItem(doc, schema, ['media']).media as SearchResultItem['media'] | undefined;
      if (media && media.length > 0) item.media = media;
    }

    return item;
  });

  // Batch-fetch mentions (still in its own table for precise filtering)
  if (items.length > 0) {
    const orClauses = items.map(() => '(site = ? AND item_id = ?)').join(' OR ');
    const bindValues: SqlValue[] = [];
    for (const item of items) {
      bindValues.push(item.site, item.id);
    }

    const mentionRows = db.prepare(
      `SELECT site, item_id, handle FROM item_mentions WHERE ${orClauses}`,
    ).all(...bindValues) as Array<{ site: string; item_id: string; handle: string }>;
    const mentionMap = new Map<string, string[]>();
    for (const row of mentionRows) {
      const key = `${row.site}:${row.item_id}`;
      const arr = mentionMap.get(key);
      if (arr) arr.push(row.handle);
      else mentionMap.set(key, [row.handle]);
    }

    for (const item of items) {
      const key = `${item.site}:${item.id}`;
      const mentions = mentionMap.get(key);
      if (mentions) item.mentions = mentions;
    }
  }

  items = applyFieldsFilter(items, params.fields);

  return { items };
}

export function countItems(db: DatabaseSync, params: CountItemsParams): number {
  const conditions: string[] = ['i.site = ?'];
  const joins: string[] = [];
  const values: SqlValue[] = [params.site];

  if (params.metricFilters) {
    for (let idx = 0; idx < params.metricFilters.length; idx++) {
      const mf = params.metricFilters[idx];
      const alias = `mf${idx}`;
      joins.push(`JOIN item_metrics ${alias} ON ${alias}.site = i.site AND ${alias}.item_id = i.id`);
      conditions.push(`${alias}.metric = ?`);
      values.push(mf.metric);

      if (mf.numValue != null) {
        conditions.push(`${alias}.num_value ${mf.op} ?`);
        values.push(mf.numValue);
      } else if (mf.realValue != null) {
        conditions.push(`${alias}.real_value ${mf.op} ?`);
        values.push(mf.realValue);
      } else if (mf.strValue != null) {
        conditions.push(`${alias}.str_value ${mf.op} ?`);
        values.push(mf.strValue);
      }
    }
  }

  const sql = `SELECT COUNT(*) as cnt FROM items i ${joins.join(' ')} WHERE ${conditions.join(' AND ')}`;
  const row = db.prepare(sql).get(...values) as { cnt: number };
  return row.cnt;
}

export function statsBySite(db: DatabaseSync, site?: string): Record<string, SiteStats> {
  const condition = site ? 'WHERE site = ?' : '';
  const values: SqlValue[] = site ? [site] : [];

  const rows = db.prepare(`
    SELECT site,
           COUNT(*) as total,
           COUNT(DISTINCT author) as authors,
           MIN(timestamp) as oldest,
           MAX(timestamp) as newest
    FROM items
    ${condition}
    GROUP BY site
  `).all(...values) as Array<{
    site: string; total: number; authors: number; oldest: string; newest: string;
  }>;

  const result: Record<string, SiteStats> = {};
  for (const row of rows) {
    result[row.site] = {
      totalPosts: row.total,
      uniqueAuthors: row.authors,
      oldestPost: row.oldest,
      newestPost: row.newest,
    };
  }
  return result;
}
