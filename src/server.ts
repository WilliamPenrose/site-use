import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLogin, getFeed } from './sites/twitter/workflows.js';
import { twitterSiteConfig } from './sites/twitter/site.js';
import type { Primitives } from './primitives/types.js';
import { ensureBrowser, isBrowserConnected } from './browser/browser.js';
import { buildPrimitivesStack, type PrimitivesStack } from './primitives/factory.js';
import { getConfig } from './config.js';
import { Mutex } from './mutex.js';
import { withLock } from './lock.js';
import path from 'node:path';
import fs from 'node:fs';
import { SiteUseError, BrowserDisconnected, RateLimited } from './errors.js';
import { createStore, type KnowledgeStore } from './storage/index.js';
import { SEARCH_FIELDS } from './storage/types.js';

// ---------------------------------------------------------------------------
// Primitives singleton + lazy Chrome + disconnect recovery
// ---------------------------------------------------------------------------

let stack: PrimitivesStack | null = null;

async function getPrimitives(): Promise<PrimitivesStack> {
  if (stack && isBrowserConnected()) {
    return stack;
  }

  // Disconnected or first call — (re)create everything
  stack = null;

  const browser = await ensureBrowser({ autoLaunch: true });
  stack = buildPrimitivesStack(browser, [twitterSiteConfig]);
  return stack;
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
    stack = null;
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
            const s = await getPrimitives();
            const result = await checkLogin(s.throttled);
            resetErrorStreak();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
          } catch (err) {
            return await formatToolError(err, stack?.guarded);
          }
        });
      });
    },
  );

  // -- twitter_feed ----------------------------------------------------------

  server.registerTool(
    'twitter_feed',
    {
      description: 'Collect tweets from the Twitter/X home feed',
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
          try {
            const s = await getPrimitives();
            const store = getOrCreateStore();
            const result = await getFeed(s.guarded, count, tab, debug, store);
            resetErrorStreak();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
          } catch (err) {
            return await formatToolError(err, stack?.guarded);
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
          try {
            const s = await getPrimitives();
            const data = await s.guarded.screenshot(site);
            resetErrorStreak();
            return {
              content: [{ type: 'image' as const, data, mimeType: 'image/png' }],
            };
          } catch (err) {
            return await formatToolError(err, stack?.guarded);
          }
        });
      });
    },
  );

  // -- search ---------------------------------------------------------------

  server.registerTool(
    'search',
    {
      description: 'Search the local knowledge base of collected social media posts',
      inputSchema: {
        query: z.string().optional()
          .describe('Full-text search query'),
        author: z.string().optional()
          .describe('Filter by author handle (without @ prefix)'),
        start_date: z.string().optional()
          .describe('Return items after this date (ISO 8601, e.g. 2026-03-01T00:00:00Z)'),
        end_date: z.string().optional()
          .describe('Return items before this date (ISO 8601, e.g. 2026-03-24T00:00:00Z)'),
        max_results: z.number().min(1).max(100).default(20)
          .describe('Maximum number of results to return'),
        hashtag: z.string().optional()
          .describe('Filter by hashtag (without # prefix)'),
        mention: z.string().optional()
          .describe('Filter by mentioned handle (without @ prefix)'),
        min_likes: z.number().optional()
          .describe('Minimum likes threshold'),
        min_retweets: z.number().optional()
          .describe('Minimum retweets threshold'),
        fields: z.array(z.enum(SEARCH_FIELDS)).optional()
          .describe('Fields to include in results. Defaults to all fields.'),
      },
    },
    async ({ query, author, start_date, end_date, max_results, hashtag, mention, min_likes, min_retweets, fields }) => {
      try {
        const store = getOrCreateStore();
        const metricFilters: Array<{ metric: string; op: '>=' | '<=' | '='; numValue?: number }> = [];
        if (min_likes != null) metricFilters.push({ metric: 'likes', op: '>=', numValue: min_likes });
        if (min_retweets != null) metricFilters.push({ metric: 'retweets', op: '>=', numValue: min_retweets });
        const result = await store.search({
          query, author, start_date, end_date, max_results, hashtag, mention,
          metricFilters: metricFilters.length > 0 ? metricFilters : undefined,
          fields,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Test seam — allows injecting a mock primitives for contract tests
// ---------------------------------------------------------------------------

export function _setPrimitivesForTest(s: PrimitivesStack | null): void {
  stack = s;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
