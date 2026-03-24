import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLogin, getFeed } from './sites/twitter/workflows.js';
import { twitterSite, twitterDetect } from './sites/twitter/site.js';
import type { Primitives } from './primitives/types.js';
import { ensureBrowser, isBrowserConnected } from './browser/browser.js';
import { PuppeteerBackend } from './primitives/puppeteer-backend.js';
import { RateLimitDetector } from './primitives/rate-limit-detect.js';
import { createThrottledPrimitives } from './primitives/throttle.js';
import { createAuthGuardedPrimitives } from './primitives/auth-guard.js';
import { matchByRule, rules } from './sites/twitter/matchers.js';
import { getConfig } from './config.js';
import { Mutex } from './mutex.js';
import { withLock } from './lock.js';
import path from 'node:path';
import fs from 'node:fs';
import { SiteUseError, BrowserDisconnected, RateLimited } from './errors.js';
import { createStore, type KnowledgeStore } from './storage/index.js';

// ---------------------------------------------------------------------------
// Primitives singleton + lazy Chrome + disconnect recovery
// ---------------------------------------------------------------------------

let primitivesInstance: Primitives | null = null;
let throttledInstance: Primitives | null = null;

async function getPrimitives(): Promise<Primitives> {
  if (primitivesInstance && isBrowserConnected()) {
    return primitivesInstance;
  }

  // Disconnected or first call — (re)create everything
  primitivesInstance = null;
  throttledInstance = null;

  const browser = await ensureBrowser({ autoLaunch: true });
  const detector = new RateLimitDetector({ twitter: twitterDetect });
  const raw = new PuppeteerBackend(browser, {
    [twitterSite.name]: [...twitterSite.domains],
  }, detector);
  const throttled = createThrottledPrimitives(raw);

  // Proxy auth (page-level) — must happen after backend creation
  const config = getConfig();
  if (config.proxy?.username) {
    const page = await raw.getRawPage();
    await page.authenticate({
      username: config.proxy.username,
      password: config.proxy.password ?? '',
    });
  }

  const guarded = createAuthGuardedPrimitives(throttled, [{
    site: twitterSite.name,
    domains: [...twitterSite.domains],
    check: async (inner) => {
      // Replicate both checks from checkLogin: URL redirect + ARIA snapshot
      const currentUrl = await inner.evaluate<string>('window.location.href', 'twitter');
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
        return false;
      }
      const snapshot = await inner.takeSnapshot('twitter');
      return !!matchByRule(snapshot, rules.homeNavLink);
    },
  }]);

  throttledInstance = throttled;
  primitivesInstance = guarded;
  return guarded;
}

// ---------------------------------------------------------------------------
// Knowledge store singleton
// ---------------------------------------------------------------------------

let storeInstance: KnowledgeStore | null = null;

function getOrCreateStore(): KnowledgeStore {
  if (!storeInstance) {
    const config = getConfig();
    const dbPath = path.join(config.dataDir, 'data', 'knowledge.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    storeInstance = createStore(dbPath);
  }
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Circuit breaker — trip after N consecutive non-trivial errors
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_THRESHOLD = 5;
let errorStreak = 0;

export function resetErrorStreak(): void {
  errorStreak = 0;
}

export function _getErrorStreak(): number {
  return errorStreak;
}

// ---------------------------------------------------------------------------
// Error formatting — structured JSON + isError for MCP
// ---------------------------------------------------------------------------

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export async function formatToolError(err: unknown, primitives?: Primitives): Promise<ToolResult> {
  if (err instanceof BrowserDisconnected) {
    // Force reconnect on next tool call
    primitivesInstance = null;
    // Don't count browser crashes toward the circuit breaker
  } else if (err instanceof RateLimited) {
    // Already rate limited — don't count to avoid re-triggering
  } else {
    errorStreak++;
    if (errorStreak >= CIRCUIT_BREAKER_THRESHOLD) {
      errorStreak = 0;
      const lastErrorType = err instanceof SiteUseError ? err.type : 'unknown';
      const lastErrorMsg = err instanceof Error ? err.message : String(err);
      const cbErr = new RateLimited(
        `${CIRCUIT_BREAKER_THRESHOLD} consecutive operation failures — circuit breaker triggered (last: ${lastErrorType})`,
        {
          step: 'circuitBreaker',
          hint: `circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} operations failed in a row (last error: ${lastErrorMsg}). The site may be rate-limiting or experiencing issues. Wait a few minutes before retrying.`,
        },
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ type: cbErr.type, message: cbErr.message, context: cbErr.context }),
        }],
        isError: true,
      };
    }
  }

  if (err instanceof SiteUseError) {
    // Auto-screenshot (skip for BrowserDisconnected — browser is gone)
    if (primitives && !(err instanceof BrowserDisconnected)) {
      try {
        const screenshot = await primitives.screenshot();
        err.context.screenshotBase64 = screenshot;
      } catch {
        // Screenshot failed — don't mask the original error
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          type: err.type,
          message: err.message,
          context: err.context,
        }),
      }],
      isError: true,
    };
  }

  // Unknown / internal error
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        type: 'InternalError',
        message: err instanceof Error ? err.message : String(err),
        context: {},
      }),
    }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

const mutex = new Mutex();

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'site-use',
    version: '0.1.0',
  });

  // -- twitter_check_login --------------------------------------------------

  server.registerTool(
    'twitter_check_login',
    { description: 'Check if the user is logged in to Twitter/X' },
    async () => {
      return withLock(async () => {
        return mutex.run(async () => {
          try {
            await getPrimitives(); // ensures both instances are initialized
            const result = await checkLogin(throttledInstance!);
            resetErrorStreak();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
          } catch (err) {
            return await formatToolError(err, primitivesInstance ?? undefined);
          }
        });
      });
    },
  );

  // -- twitter_timeline -----------------------------------------------------

  server.registerTool(
    'twitter_timeline',
    {
      description: 'Collect tweets from the Twitter/X home timeline',
      inputSchema: {
        count: z.number().min(1).max(100).default(20)
          .describe('Number of tweets to collect'),
        tab: z.enum(['following', 'for_you']).default('following')
          .describe('Which feed tab to read: "following" (chronological) or "for_you" (algorithmic)'),
        debug: z.boolean().default(false)
          .describe('Include diagnostic info (tab action, reload fallback, GraphQL counts, timing)'),
      },
    },
    async ({ count, tab, debug }) => {
      return withLock(async () => {
        return mutex.run(async () => {
          let primitives: Primitives | undefined;
          try {
            primitives = await getPrimitives();
            const store = getOrCreateStore();
            const result = await getFeed(primitives, count, tab, debug, store);
            resetErrorStreak();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
          } catch (err) {
            return await formatToolError(err, primitives);
          }
        });
      });
    },
  );

  // -- screenshot -----------------------------------------------------------

  server.registerTool(
    'screenshot',
    {
      description: 'Take a screenshot of the current browser page, returned as base64 PNG',
      inputSchema: {
        site: z.string().optional()
          .describe('Site key (defaults to the most recently used page)'),
      },
    },
    async ({ site }) => {
      return withLock(async () => {
        return mutex.run(async () => {
          let primitives: Primitives | undefined;
          try {
            primitives = await getPrimitives();
            const data = await primitives.screenshot(site);
            resetErrorStreak();
            return {
              content: [{ type: 'image' as const, data, mimeType: 'image/png' }],
            };
          } catch (err) {
            return await formatToolError(err, primitives);
          }
        });
      });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Test seam — allows injecting a mock primitives for contract tests
// ---------------------------------------------------------------------------

export function _setPrimitivesForTest(p: Primitives | null): void {
  primitivesInstance = p;
  throttledInstance = p;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
