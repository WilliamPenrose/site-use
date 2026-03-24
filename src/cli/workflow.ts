import type { Browser } from 'puppeteer-core';
import type { Primitives } from '../primitives/types.js';
import type { FeedResult } from '../sites/twitter/types.js';
import { ensureBrowser } from '../browser/browser.js';
import { PuppeteerBackend } from '../primitives/puppeteer-backend.js';
import { RateLimitDetector } from '../primitives/rate-limit-detect.js';
import { createThrottledPrimitives } from '../primitives/throttle.js';
import { createAuthGuardedPrimitives } from '../primitives/auth-guard.js';
import { twitterSite, twitterDetect } from '../sites/twitter/site.js';
import { matchByRule, rules } from '../sites/twitter/matchers.js';
import { getFeed, type TimelineFeed } from '../sites/twitter/workflows.js';
import { getConfig } from '../config.js';
import { withLock } from '../lock.js';
import { createStore, type KnowledgeStore } from '../storage/index.js';
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
}

export function parseFeedArgs(args: string[]): FeedArgs {
  const result: FeedArgs = { count: 20, tab: 'following', debug: false, json: false };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--count':
        result.count = parseInt(args[++i], 10);
        break;
      case '--tab':
        result.tab = args[++i] as TimelineFeed;
        break;
      case '--debug':
        result.debug = true;
        break;
      case '--json':
        result.json = true;
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
  const detector = new RateLimitDetector({ twitter: twitterDetect });
  const raw = new PuppeteerBackend(browser, {
    [twitterSite.name]: [...twitterSite.domains],
  }, detector);
  const throttled = createThrottledPrimitives(raw);

  const guarded = createAuthGuardedPrimitives(throttled, [{
    site: twitterSite.name,
    domains: [...twitterSite.domains],
    check: async (inner) => {
      const currentUrl = await inner.evaluate<string>('window.location.href', 'twitter');
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
        return false;
      }
      const snapshot = await inner.takeSnapshot('twitter');
      return !!matchByRule(snapshot, rules.homeNavLink);
    },
  }]);

  return guarded;
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

// ---------------------------------------------------------------------------
// Human-readable tweet output
// ---------------------------------------------------------------------------

export function formatHumanReadable(result: FeedResult): string {
  const lines: string[] = [];

  for (let i = 0; i < result.tweets.length; i++) {
    const tweet = result.tweets[i];
    const time = formatTimestamp(tweet.timestamp);

    lines.push(`@${tweet.author.handle} · ${time}`);
    lines.push(tweet.text);

    const parts: string[] = [];
    if (tweet.metrics.likes != null) parts.push(`likes: ${tweet.metrics.likes.toLocaleString()}`);
    if (tweet.metrics.retweets != null) parts.push(`retweets: ${tweet.metrics.retweets.toLocaleString()}`);
    if (tweet.metrics.replies != null) parts.push(`replies: ${tweet.metrics.replies.toLocaleString()}`);
    if (parts.length > 0) lines.push(parts.join('  '));

    lines.push(tweet.url);

    if (i < result.tweets.length - 1) {
      lines.push('───────────────────────────────────');
    }
  }

  lines.push('');
  const noun = result.tweets.length === 1 ? 'tweet' : 'tweets';
  lines.push(`Collected ${result.tweets.length} ${noun}`);

  if (result.debug) {
    lines.push('');
    lines.push(`[debug] tab=${result.debug.tabRequested} nav=${result.debug.navAction} tabAction=${result.debug.tabAction} reload=${result.debug.reloadFallback} graphql=${result.debug.graphqlResponseCount} raw=${result.debug.rawBeforeFilter} elapsed=${result.debug.elapsedMs}ms`);
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

async function runTwitterFeed(args: string[]): Promise<void> {
  const parsed = parseFeedArgs(args);

  try {
    await withLock(async () => {
      const browser = await ensureBrowser();
      const primitives = buildPrimitives(browser);

      const config = getConfig();
      if (config.proxy?.username) {
        const pages = await browser.pages();
        const page = pages[0];
        if (page) {
          await page.authenticate({
            username: config.proxy.username,
            password: config.proxy.password ?? '',
          });
        }
      }

      // Open store for auto-ingest
      const config2 = getConfig();
      const dbPath = path.join(config2.dataDir, 'data', 'knowledge.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const store = createStore(dbPath);

      let result: FeedResult;
      try {
        result = await getFeed(primitives, parsed.count, parsed.tab, parsed.debug, store);
      } finally {
        store.close();
      }

      // Disconnect (Chrome stays alive)
      browser.disconnect();

      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatHumanReadable(result));
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
          console.log(`site-use twitter — Twitter workflow commands

Subcommands:
  feed    Collect tweets from the home timeline

Options (feed):
  --count <n>     Number of tweets (default: 20)
  --tab <name>    Feed tab: following | for_you (default: following)
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
