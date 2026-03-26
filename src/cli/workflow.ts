import type { Browser } from 'puppeteer-core';
import type { Primitives } from '../primitives/types.js';
import type { FeedResult } from '../registry/types.js';
import { ensureBrowser } from '../browser/browser.js';
import { buildPrimitivesStack } from '../primitives/factory.js';
import { twitterSiteConfig } from '../sites/twitter/site.js';
import { getFeed, type TimelineFeed } from '../sites/twitter/workflows.js';
import { getConfig } from '../config.js';
import { withLock } from '../lock.js';
import { createStore } from '../storage/index.js';
import type { SearchParams } from '../storage/types.js';
import { tweetToSearchResultItem, feedItemsToIngestItems } from '../sites/twitter/store-adapter.js';
import { formatTweetText } from '../sites/twitter/format.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { checkFreshness, formatAge } from './freshness.js';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface FeedArgs {
  count: number;
  tab: TimelineFeed;
  debug: boolean;
  json: boolean;
  local: boolean;
  fetch: boolean;
  maxAge: number;
  dumpRaw?: string;
}

export function parseFeedArgs(args: string[]): FeedArgs {
  const result: FeedArgs = { count: 20, tab: 'following', debug: false, json: false, local: false, fetch: false, maxAge: 120 };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--count': {
        const n = parseInt(args[++i], 10);
        if (isNaN(n) || n < 1 || n > 100) {
          throw new Error(`Invalid --count: expected 1-100, got "${args[i]}"`);
        }
        result.count = n;
        break;
      }
      case '--tab': {
        const val = args[++i];
        if (val !== 'following' && val !== 'for_you') {
          throw new Error(`Invalid --tab: expected "following" or "for_you", got "${val}"`);
        }
        result.tab = val;
        break;
      }
      case '--debug':
        result.debug = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--local':
        result.local = true;
        break;
      case '--dump-raw':
        result.dumpRaw = args[++i];
        break;
      case '--fetch':
        result.fetch = true;
        break;
      case '--max-age': {
        const n = parseInt(args[++i], 10);
        if (isNaN(n) || n < 0) {
          throw new Error(`Invalid --max-age: expected non-negative number, got "${args[i]}"`);
        }
        result.maxAge = n;
        break;
      }
    }
    i++;
  }

  if (result.fetch && result.local) {
    throw new Error('--fetch and --local are mutually exclusive.');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build primitives (same stack as server.ts but no caching)
// ---------------------------------------------------------------------------

export function buildPrimitives(browser: Browser): Primitives {
  return buildPrimitivesStack(browser, [twitterSiteConfig]).guarded;
}

// ---------------------------------------------------------------------------
// Feed output formatting
// ---------------------------------------------------------------------------

function formatFeedOutput(result: FeedResult): string {
  const searchItems = result.items.map((fi) => ({
    id: fi.id,
    site: 'twitter' as const,
    text: fi.text,
    author: fi.author.handle,
    timestamp: fi.timestamp,
    url: fi.url,
    links: fi.links,
    media: fi.media,
    siteMeta: fi.siteMeta,
  }));
  const parts = searchItems.map(formatTweetText);
  const body = parts.join('\n\n---\n\n');
  const noun = result.items.length === 1 ? 'tweet' : 'tweets';
  const lines = [body, '', `Collected ${result.items.length} ${noun}`];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Error output helper
// ---------------------------------------------------------------------------

function writeError(error: string, message: string, hint: string): void {
  process.stderr.write(JSON.stringify({ error, message, hint }) + '\n');
  process.exitCode = 1;
}

function writeHint(message: string): void {
  process.stderr.write(message + '\n');
}

// ---------------------------------------------------------------------------
// runTwitterFeed — main CLI flow
// ---------------------------------------------------------------------------

const FEED_HELP = `\
site-use twitter feed — Collect tweets from the home timeline

Options:
  --count <n>            Number of tweets (1-100, default: 20)
  --tab <name>           Feed tab: following | for_you (default: following)
  --fetch                Force fetch from browser (skip freshness check)
  --local                Force local cache query (no browser)
  --max-age <minutes>    Max cache age before auto-fetching (default: 120)
  --debug                Include diagnostic info
  --json                 Output as JSON
  --dump-raw <dir>       Dump raw GraphQL responses to directory for debugging
`;

async function runLocalQuery(parsed: FeedArgs, dbPath: string): Promise<void> {
  if (!fs.existsSync(dbPath)) {
    writeError('DatabaseNotFound', 'No local data found', 'Run twitter feed without --local first to populate the cache');
    return;
  }
  const store = createStore(dbPath);
  try {
    const searchParams: SearchParams = {
      site: 'twitter',
      max_results: parsed.count,
      ...(parsed.tab === 'following' && {
        metricFilters: [{ metric: 'following', op: '=' as const, numValue: 1 }],
      }),
    };
    const result = await store.search(searchParams);
    if (result.items.length === 0) {
      writeError('NoResults', 'No cached tweets found', 'Run twitter feed without --local first');
      return;
    }
    if (parsed.json) {
      console.log(JSON.stringify(result.items, null, 2));
    } else {
      const parts = result.items.map(formatTweetText);
      const body = parts.join('\n\n---\n\n');
      const noun = result.items.length === 1 ? 'tweet' : 'tweets';
      console.log(`${body}\n\nFound ${result.items.length} cached ${noun}`);
    }
  } finally {
    store.close();
  }
}

async function runFetchFromBrowser(parsed: FeedArgs, config: ReturnType<typeof getConfig>, dbPath: string): Promise<void> {
  try {
    await withLock(async () => {
      const browser = await ensureBrowser({ autoLaunch: true });
      const primitives = buildPrimitives(browser);

      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const store = createStore(dbPath);

      let result: FeedResult;
      try {
        result = await getFeed(primitives, { count: parsed.count, tab: parsed.tab, dumpRaw: parsed.dumpRaw });
        // Persist to knowledge store — best-effort, never breaks the main flow
        try {
          const ingestItems = feedItemsToIngestItems(result.items);
          await store.ingest(ingestItems);
        } catch (err) {
          console.warn('Knowledge store ingest failed:', err);
        }
      } finally {
        store.close();
      }

      browser.disconnect();

      // Record successful fetch time
      setLastFetchTime(path.join(config.dataDir, 'fetch-timestamps.json'), 'twitter', parsed.tab);

      if (parsed.json) {
        const searchItems = result.items.map((fi) => ({
          id: fi.id,
          site: 'twitter' as const,
          text: fi.text,
          author: fi.author.handle,
          timestamp: fi.timestamp,
          url: fi.url,
          links: fi.links,
          media: fi.media,
          siteMeta: fi.siteMeta,
        }));
        console.log(JSON.stringify(searchItems, null, 2));
      } else {
        console.log(formatFeedOutput(result));
      }
    });
  } catch (err) {
    const errName = err instanceof Error ? err.constructor.name : 'UnknownError';
    const errMsg = err instanceof Error ? err.message : String(err);
    const hint = (err as { context?: { hint?: string } })?.context?.hint ?? 'Check Chrome status and try again.';
    writeError(errName, errMsg, hint);
  }
}

async function runTwitterFeed(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log(FEED_HELP);
    return;
  }
  const parsed = parseFeedArgs(args);
  const config = getConfig();
  const dbPath = path.join(config.dataDir, 'data', 'knowledge.db');

  // Determine mode: forced local, forced fetch, or auto
  let useLocal: boolean;

  if (parsed.local) {
    writeHint('Using local data (--local).');
    useLocal = true;
  } else if (parsed.fetch) {
    writeHint('Fetching fresh data (--fetch)...');
    useLocal = false;
  } else {
    // Smart default: check freshness
    const freshness = checkFreshness(config.dataDir, 'twitter', parsed.tab, parsed.maxAge);
    if (freshness.reason === 'no_data') {
      writeHint(`No local data for "${parsed.tab}" tab. Fetching...`);
      useLocal = false;
    } else if (freshness.reason === 'stale') {
      const label = formatAge(freshness.ageMinutes!);
      writeHint(`Local data is stale (${label} old). Fetching fresh data...`);
      useLocal = false;
    } else {
      // fresh — check if DB exists and has items
      if (!fs.existsSync(dbPath)) {
        writeHint(`No local data for "${parsed.tab}" tab. Fetching...`);
        useLocal = false;
      } else {
        const store = createStore(dbPath);
        try {
          // Count all twitter items — tab distinction is handled by fetch-timestamps,
          // not by metric filtering (following metric reflects author relationship,
          // not which tab the data came from)
          const count = await store.countItems({ site: 'twitter' });
          if (count === 0) {
            writeHint(`No local data for "${parsed.tab}" tab. Fetching...`);
            useLocal = false;
          } else {
            const label = formatAge(freshness.ageMinutes!);
            writeHint(`Using cached data (${label} old, ${count} tweets). Run with --fetch to force refresh.`);
            useLocal = true;
          }
        } finally {
          store.close();
        }
      }
    }
  }

  if (useLocal) {
    await runLocalQuery(parsed, dbPath);
  } else {
    await runFetchFromBrowser(parsed, config, dbPath);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runWorkflowCli(site: string, args: string[]): Promise<void> {
  const action = args[0];

  switch (site) {
    case 'twitter': {
      switch (action) {
        case 'feed':
          await runTwitterFeed(args.slice(1));
          break;
        case undefined:
        case 'help':
        case '--help':
        case '-h':
          console.log(`site-use twitter — Twitter workflow commands

Subcommands:
  feed    Collect tweets from the home timeline

Options (feed):
  --count <n>            Number of tweets (default: 20)
  --tab <name>           Feed tab: following | for_you (default: following)
  --fetch                Force fetch from browser
  --local                Force local cache query
  --max-age <minutes>    Max cache age before auto-fetching (default: 120)
  --debug                Include diagnostic info
  --json                 Output as JSON
`);
          break;
        default:
          writeError('UnknownAction', `Unknown twitter action: ${action}`, 'Available actions: feed');
      }
      break;
    }
    default:
      writeError('UnknownSite', `Unknown site: ${site}`, 'Available sites: twitter');
  }
}
