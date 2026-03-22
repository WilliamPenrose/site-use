import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLogin, getTimeline } from './sites/twitter/workflows.js';
import type { Primitives } from './primitives/types.js';
import { ensureBrowser } from './browser/browser.js';
import { PuppeteerBackend } from './primitives/puppeteer-backend.js';
import { createThrottledPrimitives } from './primitives/throttle.js';

export function createServer(primitives: Primitives): McpServer {
  const server = new McpServer({
    name: 'site-use',
    version: '0.1.0',
  });

  server.tool(
    'twitter_check_login',
    'Check if the user is logged in to Twitter/X',
    {},
    async () => {
      const result = await checkLogin(primitives);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'twitter_timeline',
    'Collect tweets from the Twitter/X home timeline',
    { count: z.number().min(1).max(100).default(20).describe('Number of tweets to collect') },
    async ({ count }) => {
      const result = await getTimeline(primitives, count);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const browser = await ensureBrowser();
  const raw = new PuppeteerBackend(browser);
  const primitives = createThrottledPrimitives(raw);
  const server = createServer(primitives);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
