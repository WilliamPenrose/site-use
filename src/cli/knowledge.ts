import path from 'node:path';
import os from 'node:os';
import { createStore } from '../storage/index.js';
import { SEARCH_FIELDS } from '../storage/types.js';
import type { SearchParams, SiteStats } from '../storage/types.js';
import { getAllTimestamps } from '../fetch-timestamps.js';
import { getKnowledgeDbPath } from '../config.js';

function getDbPath(): string {
  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  return getKnowledgeDbPath(dataDir);
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

export function parseSearchArgs(args: string[]): SearchParams {
  const params: SearchParams = {};
  let i = 0;

  const needsValue = new Set(['--author', '--start-date', '--end-date', '--max-results', '--hashtag', '--mention', '--min-likes', '--min-retweets', '--surface-reason', '--fields']);

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
        '--min-likes': '--min-likes 100',
        '--min-retweets': '--min-retweets 50',
        '--surface-reason': '--surface-reason retweet',
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
      case '--min-likes': {
        const val = parseInt(args[++i], 10);
        params.metricFilters ??= [];
        params.metricFilters.push({ metric: 'likes', op: '>=', numValue: val });
        break;
      }
      case '--min-retweets': {
        const val = parseInt(args[++i], 10);
        params.metricFilters ??= [];
        params.metricFilters.push({ metric: 'retweets', op: '>=', numValue: val });
        break;
      }
      case '--surface-reason': {
        const val = args[++i];
        if (!['original', 'retweet', 'quote', 'reply'].includes(val)) {
          process.stderr.write(`Invalid --surface-reason: expected original|retweet|quote|reply, got "${val}"\n`);
          process.exitCode = 1;
          return params;
        }
        params.metricFilters ??= [];
        params.metricFilters.push({ metric: 'surface_reason', op: '=', strValue: val });
        break;
      }
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
        "Run 'npx site-use twitter feed' to collect some tweets first.",
      );
      return;
    }
  }

  const store = createStore(dbPath);

  try {
    if (command === 'search') {
      if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`Usage: site-use search <query> [options]

Options:
  Filters:
    --author <name>        Filter by author (@ prefix optional)
    --start-date <date>    Start date (local time, flexible format)
    --end-date <date>      End date (local time, flexible format)
    --hashtag <tag>        Filter by hashtag
    --mention <handle>     Filter by mentioned handle (@ prefix optional)
    --surface-reason <r>   Filter by type: original | retweet | quote | reply
    --min-likes <n>        Minimum likes
    --min-retweets <n>     Minimum retweets

  Output:
    --max-results <n>      Max results (default: 20)
    --fields <list>        Comma-separated fields: ${SEARCH_FIELDS.join(',')}

Examples:
  site-use search "bitcoin"
  site-use search --author elonmusk --start-date 2024-01-01
  site-use search "AI" --min-likes 1000
  site-use search --fields author,url --max-results 5`);
        return;
      }

      const parsed = parseSearchArgs(args);
      if (process.exitCode) return;
      const result = await store.search(parsed);

      if (result.items.length === 0) {
        writeError(
          'NoResults',
          'No items match the search criteria',
          'Try broadening filters: remove --author or --start-date, or use a shorter query.',
        );
        return;
      }

      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'stats') {
      if (args.includes('--help') || args.includes('-h')) {
        console.log(`site-use stats — Show storage statistics\n`);
        return;
      }
      const dbStats = await store.statsBySite();
      const tsPath = path.join(
        process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use'),
        'fetch-timestamps.json',
      );
      const allTimestamps = getAllTimestamps(tsPath);

      const merged: Record<string, SiteStats & { lastCollected: Record<string, string> }> = {};
      for (const [site, s] of Object.entries(dbStats)) {
        merged[site] = { ...s, lastCollected: allTimestamps[site] ?? {} };
      }
      for (const [site, variants] of Object.entries(allTimestamps)) {
        if (!merged[site]) {
          merged[site] = {
            totalPosts: 0, uniqueAuthors: 0,
            oldestPost: '', newestPost: '',
            lastCollected: variants,
          };
        }
      }

      console.log(JSON.stringify(merged, null, 2));
    } else if (command === 'rebuild') {
      if (args.includes('--help') || args.includes('-h')) {
        console.log(`site-use rebuild — Rebuild search index

Status: Not available until Phase 2 (semantic search).
Phase 1 supports keyword search (FTS) and structured filters.
`);
        return;
      }
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
