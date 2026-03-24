import path from 'node:path';
import os from 'node:os';
import { createStore } from '../storage/index.js';
import { SEARCH_FIELDS } from '../storage/types.js';
import type { SearchParams, SearchResult, StoreStats } from '../storage/types.js';

function getDbPath(): string {
  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  return path.join(dataDir, 'data', 'knowledge.db');
}

/** Interpret user input as local time and return UTC ISO string for DB comparison. */
export function localToUtc(input: string): string {
  // Normalize '/' to '-' for Date compatibility
  let s = input.trim().replace(/\//g, '-');
  // Date-only: '2026-03-24' → append T00:00 so Date treats it as local (not UTC)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00';
  // Partial hour: '2026-03-24 09' → '2026-03-24T09:00'
  else if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}$/.test(s)) s = s.replace(/\s+/, 'T') + ':00';
  // Space separator: '2026-03-24 09:00' → '2026-03-24T09:00'
  else s = s.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const d = new Date(s);
  if (isNaN(d.getTime())) return input; // fallback: pass through as-is
  return d.toISOString();
}

export function parseSearchArgs(args: string[]): SearchParams & { json?: boolean } {
  const params: SearchParams & { json?: boolean } = {};
  let i = 0;

  const needsValue = new Set(['--author', '--start-date', '--end-date', '--max-results', '--hashtag', '--mention', '--link', '--min-likes', '--min-retweets', '--fields']);

  while (i < args.length) {
    const arg = args[i];
    if (needsValue.has(arg) && (i + 1 >= args.length || args[i + 1].startsWith('--'))) {
      const examples: Record<string, string> = {
        '--author': '--author elonmusk',
        '--start-date': '--start-date 2026-03-01',
        '--end-date': '--end-date 2026-03-24',
        '--max-results': '--max-results 10',
        '--hashtag': '--hashtag AI',
        '--mention': '--mention openai',
        '--link': '--link github.com',
        '--min-likes': '--min-likes 100',
        '--min-retweets': '--min-retweets 50',
        '--fields': `--fields ${SEARCH_FIELDS.join(',')}`,
      };
      process.stderr.write(`Missing value for ${arg}\nUsage: ${examples[arg] ?? arg + ' <value>'}\n`);
      process.exitCode = 1;
      return params;
    }
    switch (arg) {
      case '--author':
        params.author = args[++i]?.replace(/^@/, '');
        break;
      case '--start-date':
        params.start_date = localToUtc(args[++i]);
        break;
      case '--end-date':
        params.end_date = localToUtc(args[++i]);
        break;
      case '--max-results':
        params.max_results = parseInt(args[++i], 10);
        break;
      case '--hashtag':
        params.hashtag = args[++i];
        break;
      case '--mention':
        params.mention = args[++i]?.replace(/^@/, '');
        break;
      case '--link':
        params.link = args[++i];
        break;
      case '--min-likes':
        params.min_likes = parseInt(args[++i], 10);
        break;
      case '--min-retweets':
        params.min_retweets = parseInt(args[++i], 10);
        break;
      case '--fields': {
        const raw = args[++i].split(',');
        const valid = new Set<string>(SEARCH_FIELDS);
        const invalid = raw.filter((f) => !valid.has(f));
        if (invalid.length > 0) {
          process.stderr.write(`Unknown field(s): ${invalid.join(', ')}\nValid fields: ${SEARCH_FIELDS.join(',')}\n`);
          process.exitCode = 1;
          return params;
        }
        params.fields = raw as SearchParams['fields'];
        break;
      }
      case '--json':
        params.json = true;
        break;
      default:
        if (arg.startsWith('--')) {
          const renames: Record<string, string> = {
            '--since': '--start-date', '--until': '--end-date', '--limit': '--max-results',
          };
          const hint = renames[arg];
          if (hint) {
            process.stderr.write(`Unknown option: ${arg} (renamed to ${hint})\n`);
          } else {
            process.stderr.write(`Unknown option: ${arg}\n`);
          }
          process.exitCode = 1;
          return params;
        }
        params.query = arg;
        break;
    }
    i++;
  }

  return params;
}

export function formatHumanReadable(result: SearchResult): string {
  const lines: string[] = [];
  let rendered = 0;

  for (const item of result.items) {
    const itemLines: string[] = [];
    const header: string[] = [];
    if (item.author) header.push(`@${item.author}`);
    if (item.timestamp) {
      const d = new Date(item.timestamp);
      header.push(d.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
    }
    if (header.length > 0) itemLines.push(header.join(' · '));
    if (item.text) itemLines.push(item.text);

    if (item.siteMeta) {
      const meta = item.siteMeta as Record<string, unknown>;
      const parts: string[] = [];
      if (meta.likes != null) parts.push(`likes: ${Number(meta.likes).toLocaleString()}`);
      if (meta.retweets != null) parts.push(`retweets: ${Number(meta.retweets).toLocaleString()}`);
      if (meta.replies != null) parts.push(`replies: ${Number(meta.replies).toLocaleString()}`);
      if (parts.length > 0) itemLines.push(parts.join('  '));
    }

    if (item.mentions && item.mentions.length > 0) itemLines.push(`mentions: ${item.mentions.map(m => '@' + m).join(' ')}`);
    if (item.links && item.links.length > 0) itemLines.push(`links: ${item.links.join(' ')}`);
    if (item.media && item.media.length > 0) {
      for (const m of item.media) {
        const dim = m.width && m.height ? ` ${m.width}x${m.height}` : '';
        const dur = m.duration != null ? ` ${m.duration}ms` : '';
        itemLines.push(`media: ${m.type}${dim}${dur} ${m.url}`);
      }
    }
    if (item.url) itemLines.push(item.url);

    if (itemLines.length === 0) continue;

    if (rendered > 0) lines.push('───────────────────────────────────');
    lines.push(...itemLines);
    rendered++;
  }

  lines.push('');
  const noun = rendered === 1 ? 'result' : 'results';
  lines.push(`Found ${rendered} ${noun}`);

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
        "Run 'npx site-use mcp' and fetch some tweets first with twitter_timeline to populate the database.",
      );
      return;
    }
  }

  const store = createStore(dbPath);

  try {
    if (command === 'search') {
      if (args.length === 0) {
        console.log(`Usage: site-use search <query> [options]

Options:
  --author <name>        Filter by author (@ prefix optional)
  --start-date <date>    Start date (local time, flexible format)
  --end-date <date>      End date (local time, flexible format)
  --max-results <n>      Max results (default: 20)
  --hashtag <tag>        Filter by hashtag
  --mention <handle>     Filter by mentioned handle (@ prefix optional)
  --link <substr>        Filter by URL substring in expanded links
  --min-likes <n>        Minimum likes
  --min-retweets <n>     Minimum retweets
  --fields <list>        Comma-separated fields: ${SEARCH_FIELDS.join(',')}
  --json                 Output as JSON

Examples:
  site-use search "bitcoin"
  site-use search --author elonmusk --start-date 2024-01-01
  site-use search "AI" --min-likes 1000 --json
  site-use search --fields author,url --max-results 5`);
        return;
      }

      const parsed = parseSearchArgs(args);
      if (process.exitCode) return;
      const isJson = parsed.json;
      delete parsed.json;
      const result = await store.search(parsed);

      if (result.items.length === 0) {
        writeError(
          'NoResults',
          'No items match the search criteria',
          'Try broadening filters: remove --author or --start-date, or use a shorter query.',
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
