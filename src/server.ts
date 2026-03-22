import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLogin, getTimeline } from './sites/twitter/workflows.js';
import type { Primitives } from './primitives/types.js';
import { ensureBrowser, isBrowserConnected } from './browser/browser.js';
import { PuppeteerBackend } from './primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from './primitives/throttle.js';
import { getConfig } from './config.js';
import { Mutex } from './mutex.js';
import { SiteUseError, BrowserDisconnected } from './errors.js';

// ---------------------------------------------------------------------------
// Primitives singleton + lazy Chrome + disconnect recovery
// ---------------------------------------------------------------------------

let primitivesInstance: Primitives | null = null;

async function getPrimitives(): Promise<Primitives> {
  if (primitivesInstance && isBrowserConnected()) {
    return primitivesInstance;
  }

  // Disconnected or first call — (re)create everything
  primitivesInstance = null;

  const browser = await ensureBrowser();
  const raw = new PuppeteerBackend(browser);
  const primitives = createThrottledPrimitives(raw);

  // Proxy auth (page-level) — must happen after backend creation
  const config = getConfig();
  if (config.proxy?.username) {
    const page = await raw.getRawPage();
    await page.authenticate({
      username: config.proxy.username,
      password: config.proxy.password ?? '',
    });
  }

  primitivesInstance = primitives;
  return primitives;
}

// ---------------------------------------------------------------------------
// Error formatting — structured JSON + isError for MCP
// ---------------------------------------------------------------------------

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export function formatToolError(err: unknown): ToolResult {
  if (err instanceof BrowserDisconnected) {
    // Force reconnect on next tool call
    primitivesInstance = null;
  }

  if (err instanceof SiteUseError) {
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
      return mutex.run(async () => {
        try {
          const primitives = await getPrimitives();
          const result = await checkLogin(primitives);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          return formatToolError(err);
        }
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
      },
    },
    async ({ count }) => {
      return mutex.run(async () => {
        try {
          const primitives = await getPrimitives();
          const result = await getTimeline(primitives, count);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          return formatToolError(err);
        }
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
      return mutex.run(async () => {
        try {
          const primitives = await getPrimitives();
          const data = await primitives.screenshot(site);
          return {
            content: [{ type: 'image' as const, data, mimeType: 'image/png' }],
          };
        } catch (err) {
          return formatToolError(err);
        }
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
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
