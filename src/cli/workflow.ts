import type { Browser } from 'puppeteer-core';
import type { Primitives } from '../primitives/types.js';
import type { FeedResult } from '../sites/twitter/types.js';
import { ensureBrowser } from '../browser/browser.js';
import { buildPrimitivesStack } from '../primitives/factory.js';
import { twitterSiteConfig } from '../sites/twitter/site.js';
import { getFeed, type TimelineFeed } from '../sites/twitter/workflows.js';
import { getConfig } from '../config.js';
import { withLock } from '../lock.js';
import { createStore, type KnowledgeStore } from '../storage/index.js';
import { tweetToSearchResultItem } from '../sites/twitter/store-adapter.js';
import { formatTweetText } from '../sites/twitter/format.js';
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
  dumpRaw?: string;
}

export function parseFeedArgs(args: string[]): FeedArgs {
  const result: FeedArgs = { count: 20, tab: 'following', debug: false, json: false, local: false };
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
    }
    i++;
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
  const items = result.tweets.map(tweetToSearchResultItem);
  const parts = items.map(formatTweetText);
  const body = parts.join('\n\n---\n\n');
  const noun = result.tweets.length === 1 ? 'tweet' : 'tweets';
  const lines = [body, '', `Collected ${result.tweets.length} ${noun}`];

  if (result.debug) {
    const d = result.debug;
    lines.push('', `[debug] tab=${d.tabRequested} nav=${d.navAction} tabAction=${d.tabAction} reload=${d.reloadFallback} graphql=${d.graphqlResponseCount} raw=${d.rawBeforeFilter} elapsed=${d.elapsedMs}ms`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Error output helper
// ---------------------------------------------------------------------------

function writeError(error: string, message: string, hint: string): void {
  process.stderr.write(JSON.stringify({ error, message, hint }) + '\n');
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// runTwitterFeed — main CLI flow
// ---------------------------------------------------------------------------

const FEED_HELP = `\
site-use twitter feed — Collect tweets from the home timeline

Options:
  --count <n>        Number of tweets (1-100, default: 20)
  --tab <name>       Feed tab: following | for_you (default: following)
  --local            Query local cache instead of fetching from browser
  --debug            Include diagnostic info
  --json             Output as JSON
  --dump-raw <dir>   Dump raw GraphQL responses to directory for debugging
`;

async function runTwitterFeed(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log(FEED_HELP);
    return;
  }
  const parsed = parseFeedArgs(args);

  try {
    await withLock(async () => {
      const browser = await ensureBrowser({ autoLaunch: true });
      const primitives = buildPrimitives(browser);

      // Open store for auto-ingest
      const config = getConfig();
      const dbPath = path.join(config.dataDir, 'data', 'knowledge.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const store = createStore(dbPath);

      let result: FeedResult;
      try {
        result = await getFeed(primitives, { count: parsed.count, tab: parsed.tab, debug: parsed.debug, store, dumpRaw: parsed.dumpRaw });
      } finally {
        store.close();
      }

      // Disconnect (Chrome stays alive)
      browser.disconnect();

      if (parsed.json) {
        const items = result.tweets.map(tweetToSearchResultItem);
        console.log(JSON.stringify(items, null, 2));
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
  --count <n>     Number of tweets (default: 20)
  --tab <name>    Feed tab: following | for_you (default: following)
  --local         Query local cache instead of fetching from browser
  --debug         Include diagnostic info
  --json          Output as JSON
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
