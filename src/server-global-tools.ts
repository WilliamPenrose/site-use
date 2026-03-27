// src/server-global-tools.ts
// Global MCP tools that don't belong to any specific site plugin:
// screenshot, search.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { SiteRuntimeManager } from './runtime/manager.js';
import { createStore, type KnowledgeStore } from './storage/index.js';
import { SEARCH_FIELDS } from './storage/types.js';
import { getConfig, getKnowledgeDbPath } from './config.js';

// ---------------------------------------------------------------------------
// Knowledge store singleton (same pattern as old server.ts)
// ---------------------------------------------------------------------------

let storeInstance: KnowledgeStore | null = null;

function getOrCreateStore(): KnowledgeStore {
  if (!storeInstance) {
    const config = getConfig();
    const dbPath = getKnowledgeDbPath(config.dataDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    storeInstance = createStore(dbPath);
  }
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGlobalTools(
  server: McpServer,
  runtimeManager: SiteRuntimeManager,
): void {
  // -- screenshot -----------------------------------------------------------
  server.registerTool(
    'screenshot',
    {
      description: 'Take a screenshot of a site\'s browser tab, returned as base64 PNG',
      inputSchema: {
        site: z.string()
          .describe('Site name (e.g. "twitter"). Required — specifies which tab to screenshot.'),
      },
    },
    async ({ site }) => {
      try {
        const runtime = await runtimeManager.get(site);
        const data = await runtime.mutex.run(() => runtime.primitives.screenshot());
        return {
          content: [{ type: 'image' as const, data, mimeType: 'image/png' }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
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
        site: z.string().optional()
          .describe('Filter by site (e.g. "twitter"). Omit to search all sites.'),
        author: z.string().optional()
          .describe('Filter by author handle (without @ prefix)'),
        start_date: z.string().optional()
          .describe('Return items after this date (ISO 8601)'),
        end_date: z.string().optional()
          .describe('Return items before this date (ISO 8601)'),
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
        surface_reason: z.enum(['original', 'retweet', 'quote', 'reply']).optional()
          .describe('Filter by how the post appeared in the feed'),
        fields: z.array(z.enum(SEARCH_FIELDS)).optional()
          .describe('Fields to include in results. Defaults to all fields.'),
      },
    },
    async ({ query, site, author, start_date, end_date, max_results, hashtag, mention, min_likes, min_retweets, surface_reason, fields }) => {
      try {
        const store = getOrCreateStore();
        const metricFilters: Array<{ metric: string; op: '>=' | '<=' | '='; numValue?: number; strValue?: string }> = [];
        if (min_likes != null) metricFilters.push({ metric: 'likes', op: '>=', numValue: min_likes });
        if (min_retweets != null) metricFilters.push({ metric: 'retweets', op: '>=', numValue: min_retweets });
        if (surface_reason != null) metricFilters.push({ metric: 'surface_reason', op: '=', strValue: surface_reason });
        const result = await store.search({
          query, site, author, start_date, end_date, max_results, hashtag, mention,
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
}
