// src/storage/query.ts
import type { DatabaseSync } from 'node:sqlite';
import type { SearchParams, SearchResult, SearchResultItem, StoreStats } from './types.js';
import { resolveItem } from '../display/resolve.js';
import { twitterDisplaySchema } from '../sites/twitter/display.js';
import type { DisplaySchema } from '../display/resolve.js';

type SqlValue = null | number | bigint | string;

const displaySchemas: Record<string, DisplaySchema> = {
  twitter: twitterDisplaySchema,
};

export function search(db: DatabaseSync, params: SearchParams): SearchResult {
  const conditions: string[] = [];
  const joins: string[] = [];
  const values: SqlValue[] = [];
  const limit = params.max_results ?? 20;

  // FTS join
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
    conditions.push('mn.handle = ?');
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
    };

    // Resolve display-only data from raw_json via display schema
    if (schema) {
      const display = resolveItem(doc, schema, [
        'likes', 'retweets', 'replies', 'views', 'bookmarks', 'quotes', 'following',
        'surfaceReason', 'surfacedBy', 'quotedTweet', 'inReplyTo',
      ]);
      if (display.likes != null || display.retweets != null || display.surfaceReason != null) {
        const meta: Record<string, unknown> = {
          likes: (display.likes as number | null) ?? null,
          retweets: (display.retweets as number | null) ?? null,
          replies: (display.replies as number | null) ?? null,
          views: (display.views as number | null) ?? null,
          bookmarks: (display.bookmarks as number | null) ?? null,
          quotes: (display.quotes as number | null) ?? null,
          following: (display.following as boolean | null) ?? null,
        };
        if (display.surfaceReason != null) meta.surfaceReason = display.surfaceReason;
        if (display.surfacedBy != null) meta.surfacedBy = display.surfacedBy;
        if (display.quotedTweet != null) meta.quotedTweet = display.quotedTweet;
        if (display.inReplyTo != null) meta.inReplyTo = display.inReplyTo;
        item.siteMeta = meta;
      }

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

  // Apply fields filter
  if (params.fields && params.fields.length > 0) {
    const f = new Set(params.fields);
    for (const item of items) {
      if (!f.has('text')) {
        delete item.text;
        // Only preserve following when it's false (shows [not following] tag)
        const following = (item.siteMeta as Record<string, unknown> | undefined)?.following;
        if (following === false && f.has('author')) {
          item.siteMeta = { following };
        } else {
          delete item.siteMeta;
        }
      }
      if (!f.has('author')) delete item.author;
      if (!f.has('url')) delete item.url;
      if (!f.has('timestamp')) delete item.timestamp;
      if (!f.has('links')) delete item.links;
      if (!f.has('mentions')) delete item.mentions;
      if (!f.has('media')) delete item.media;
    }
    items = items.filter(item => Object.keys(item).length > 2);
  }

  return { items };
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
