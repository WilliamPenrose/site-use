import path from 'node:path';
import os from 'node:os';
import { createStore } from '../storage/index.js';
import type { SearchParams, SearchResult, StoreStats } from '../storage/types.js';

function getDbPath(): string {
  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  return path.join(dataDir, 'data', 'knowledge.db');
}

export function parseSearchArgs(args: string[]): SearchParams & { json?: boolean } {
  const params: SearchParams & { json?: boolean } = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--author':
        params.author = args[++i];
        break;
      case '--since':
        params.since = args[++i];
        break;
      case '--until':
        params.until = args[++i];
        break;
      case '--limit':
        params.limit = parseInt(args[++i], 10);
        break;
      case '--hashtag':
        params.siteFilters = { ...params.siteFilters, hashtag: args[++i] };
        break;
      case '--min-likes':
        params.siteFilters = { ...params.siteFilters, minLikes: parseInt(args[++i], 10) };
        break;
      case '--min-retweets':
        params.siteFilters = { ...params.siteFilters, minRetweets: parseInt(args[++i], 10) };
        break;
      case '--json':
        params.json = true;
        break;
      default:
        if (!arg.startsWith('--')) {
          params.query = arg;
        }
        break;
    }
    i++;
  }

  return params;
}

export function formatHumanReadable(result: SearchResult): string {
  const lines: string[] = [];

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    const date = item.timestamp.replace('T', ' ').replace(/:\d{2}\.\d{3}Z$|Z$/, '');
    lines.push(`@${item.author} · ${date}`);
    lines.push(item.text);

    if (item.siteMeta) {
      const meta = item.siteMeta as Record<string, unknown>;
      const parts: string[] = [];
      if (meta.likes != null) parts.push(`likes: ${Number(meta.likes).toLocaleString()}`);
      if (meta.retweets != null) parts.push(`retweets: ${Number(meta.retweets).toLocaleString()}`);
      if (meta.replies != null) parts.push(`replies: ${Number(meta.replies).toLocaleString()}`);
      if (parts.length > 0) lines.push(parts.join('  '));
    }

    lines.push(item.url);

    if (i < result.items.length - 1) {
      lines.push('───────────────────────────────────');
    }
  }

  const noun = result.total === 1 ? 'result' : 'results';
  lines.push('');
  lines.push(`Found ${result.total} ${noun}`);

  return lines.join('\n');
}

export function formatStatsHumanReadable(s: StoreStats): string {
  const lines: string[] = [];
  lines.push(`Total items: ${s.totalItems.toLocaleString()}`);
  for (const [site, count] of Object.entries(s.bySite)) {
    lines.push(`  ${site}: ${count.toLocaleString()}`);
  }
  lines.push(`Unique authors: ${s.uniqueAuthors.toLocaleString()}`);
  if (s.timeRange) {
    lines.push(`Time range: ${s.timeRange.from} — ${s.timeRange.to}`);
  }
  return lines.join('\n');
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function writeError(error: string, message: string, hint: string): void {
  process.stderr.write(JSON.stringify({ error, message, hint }) + '\n');
  process.exitCode = 1;
}

export async function runKnowledgeCli(command: string, args: string[]): Promise<void> {
  const dbPath = getDbPath();

  if (command !== 'rebuild') {
    const fs = await import('node:fs');
    if (!fs.existsSync(dbPath)) {
      writeError(
        'DatabaseNotFound',
        `Knowledge database not found at ${dbPath}`,
        "Run 'npx site-use serve' and fetch some tweets first with twitter_timeline to populate the database.",
      );
      return;
    }
  }

  const store = createStore(dbPath);

  try {
    if (command === 'search') {
      const parsed = parseSearchArgs(args);
      const isJson = parsed.json;
      delete parsed.json;
      const result = await store.search(parsed);

      if (result.total === 0) {
        writeError(
          'NoResults',
          'No items match the search criteria',
          'Try broadening filters: remove --author or --since, or use a shorter query.',
        );
        return;
      }

      if (isJson) {
        console.log(formatJson(result));
      } else {
        console.log(formatHumanReadable(result));
      }
    } else if (command === 'stats') {
      const isJson = args.includes('--json');
      const s = await store.stats();
      if (isJson) {
        console.log(formatJson(s));
      } else {
        console.log(formatStatsHumanReadable(s));
      }
    } else if (command === 'rebuild') {
      writeError(
        'NotImplemented',
        'rebuild is not available until Phase 2 (semantic search)',
        'Phase 1 supports keyword search (FTS) and structured filters. Rebuild will be available when embedding support is added.',
      );
    }
  } finally {
    store.close();
  }
}
