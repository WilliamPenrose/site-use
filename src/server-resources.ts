// src/server-resources.ts
// MCP resources: stats (fixed URI + template).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import fs from 'node:fs';
import type { SitePlugin } from './registry/types.js';
import { createStore, type KnowledgeStore } from './storage/index.js';
import { getAllTimestamps } from './fetch-timestamps.js';
import { getConfig, getKnowledgeDbPath } from './config.js';
import { BUILD_HASH, BUILD_DATE } from './build-info.js';

function getVersion(): string {
  if (BUILD_HASH === 'dev') return 'dev';
  return `${BUILD_DATE}+${BUILD_HASH}`;
}

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

interface SiteStatsEntry {
  totalPosts: number;
  uniqueAuthors: number;
  oldestPost: string | null;
  newestPost: string | null;
  lastCollected: Record<string, string>;
  capabilities: string[];
}

interface StatsResponse {
  server: {
    version: string;
    plugins: string[];
  };
  sites: Record<string, SiteStatsEntry>;
}

function pluginCapabilities(plugin: SitePlugin): string[] {
  const caps: string[] = [];
  if (plugin.capabilities?.auth) caps.push('auth');
  if (plugin.capabilities?.feed) caps.push('feed');
  if (plugin.customWorkflows?.length) caps.push('customWorkflows');
  return caps;
}

async function buildStats(
  plugins: SitePlugin[],
  site?: string,
): Promise<StatsResponse> {
  const store = getOrCreateStore();
  const dbStats = await store.statsBySite(site);
  const cfg = getConfig();
  const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
  const allTimestamps = getAllTimestamps(tsPath);

  const pluginMap = new Map(plugins.map(p => [p.name, p]));
  const fallbackPlugin = (name: string): SitePlugin => ({ apiVersion: 1, name, domains: [] });

  const sites: StatsResponse['sites'] = {};

  for (const [siteName, siteStats] of Object.entries(dbStats)) {
    sites[siteName] = {
      ...siteStats,
      lastCollected: allTimestamps[siteName] ?? {},
      capabilities: pluginCapabilities(pluginMap.get(siteName) ?? fallbackPlugin(siteName)),
    };
  }

  for (const [siteName, variants] of Object.entries(allTimestamps)) {
    if (!sites[siteName] && (!site || siteName === site)) {
      sites[siteName] = {
        totalPosts: 0,
        uniqueAuthors: 0,
        oldestPost: null,
        newestPost: null,
        lastCollected: variants,
        capabilities: pluginCapabilities(pluginMap.get(siteName) ?? fallbackPlugin(siteName)),
      };
    }
  }

  return {
    server: {
      version: getVersion(),
      plugins: plugins.map(p => p.name),
    },
    sites,
  };
}

export function registerResources(
  server: McpServer,
  plugins: SitePlugin[],
): void {
  // Fixed resource: all sites
  server.registerResource(
    'stats',
    'site-use://stats',
    {
      description:
        'Server info and knowledge base statistics for all sites: ' +
        'version, loaded plugins, post counts, content time range, ' +
        'last collection timestamps, and plugin capabilities.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const data = await buildStats(plugins);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }],
      };
    },
  );

  // Template resource: single site
  server.registerResource(
    'stats-by-site',
    new ResourceTemplate('site-use://stats/{site}', {
      list: async () => ({
        resources: plugins.map(p => ({
          uri: `site-use://stats/${p.name}`,
          name: `${p.name} stats`,
          mimeType: 'application/json' as const,
        })),
      }),
      complete: {
        site: async () => plugins.map(p => p.name),
      },
    }),
    {
      description:
        'Server info and knowledge base statistics for a single site.',
      mimeType: 'application/json',
    },
    async (uri, { site }) => {
      const data = await buildStats(plugins, site as string);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }],
      };
    },
  );
}
