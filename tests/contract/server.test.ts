import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Primitives } from '../../src/primitives/types.js';

// Mock the runtime manager to return a mock runtime with mock primitives
const mockPrimitives: Primitives = {
  navigate: vi.fn().mockResolvedValue(undefined),
  takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
  click: vi.fn().mockResolvedValue(undefined),
  type: vi.fn().mockResolvedValue(undefined),
  scroll: vi.fn().mockResolvedValue(undefined),
  scrollIntoView: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAACAAHiIbwzAAAAAElFTkSuQmCC'),
  interceptRequest: vi.fn().mockResolvedValue(() => {}),
  getRawPage: vi.fn().mockResolvedValue({}),
};

const mockRuntime = {
  plugin: { name: 'twitter' },
  primitives: mockPrimitives,
  page: {},
  mutex: { run: async (fn: () => Promise<unknown>) => fn() },
  circuitBreaker: { isTripped: false, recordSuccess: vi.fn(), recordError: vi.fn(), streak: 0 },
  rateLimitDetector: {},
  authState: { loggedIn: null, lastCheckedAt: null },
};

vi.mock('../../src/runtime/manager.js', () => ({
  SiteRuntimeManager: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(mockRuntime),
    clearAll: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  })),
}));

vi.mock('../../src/storage/index.js', () => ({
  createStore: vi.fn(() => ({
    search: vi.fn().mockResolvedValue({ items: [] }),
    ingest: vi.fn().mockResolvedValue({ inserted: 0, duplicates: 0 }),
    stats: vi.fn().mockResolvedValue({}),
    countItems: vi.fn().mockResolvedValue(0),
    statsBySite: vi.fn().mockImplementation(async (site?: string) => {
      const all = {
        twitter: {
          totalPosts: 42,
          uniqueAuthors: 10,
          oldestPost: '2026-01-01T00:00:00.000Z',
          newestPost: '2026-03-25T00:00:00.000Z',
        },
      };
      if (site) {
        return site in all ? { [site]: (all as Record<string, unknown>)[site] } : {};
      }
      return all;
    }),
  })),
}));

vi.mock('../../src/fetch-timestamps.js', () => ({
  getAllTimestamps: vi.fn().mockImplementation((_path: string) => ({
    twitter: {
      following: '2026-03-25T10:00:00.000Z',
      for_you: '2026-03-24T08:00:00.000Z',
    },
  })),
  getLastFetchTime: vi.fn().mockReturnValue(null),
  setLastFetchTime: vi.fn(),
}));

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(),
  isBrowserConnected: vi.fn().mockReturnValue(true),
}));

describe('MCP Server contract', () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    const { createServer } = await import('../../src/server.js');
    server = await createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('responds to initialize with server info', () => {
    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe('site-use');
  });

  it('lists all four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('twitter_check_login');
    expect(toolNames).toContain('twitter_feed');
    expect(toolNames).toContain('screenshot');
    expect(toolNames).toContain('search');
  });

  it('search tool has correct schema', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t: { name: string }) => t.name === 'search');
    expect(search).toBeDefined();
    const props = search!.inputSchema.properties;
    expect(props.query).toBeDefined();
    expect(props.max_results).toBeDefined();
    expect(props.start_date).toBeDefined();
    expect(props.end_date).toBeDefined();
    expect(props.author).toBeDefined();
    expect(props.hashtag).toBeDefined();
    expect(props.mention).toBeDefined();
    expect(props.min_likes).toBeDefined();
    expect(props.min_retweets).toBeDefined();
    expect(props.fields).toBeDefined();
    expect((props.fields as any).items.enum).toEqual(
      expect.arrayContaining(['author', 'text', 'url', 'timestamp', 'links', 'mentions'])
    );
  });

  it('screenshot tool returns image content', async () => {
    // screenshot now requires a site param
    const result = await client.callTool({ name: 'screenshot', arguments: { site: 'twitter' } });
    const content = result.content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('image');
    expect(content[0].mimeType).toBe('image/png');
    expect(typeof content[0].data).toBe('string');
  });

  it('stats resource returns server info and all sites', async () => {
    const { resources } = await client.listResources();
    const statsRes = resources.find((r) => r.uri === 'site-use://stats');
    expect(statsRes).toBeDefined();
    expect(statsRes!.mimeType).toBe('application/json');

    const result = await client.readResource({ uri: 'site-use://stats' });
    const data = JSON.parse((result.contents[0] as any).text);

    // server block
    expect(data.server).toBeDefined();
    expect(data.server.version).toBeDefined();
    expect(data.server.plugins).toContain('twitter');

    // sites block
    expect(data.sites).toHaveProperty('twitter');
    const tw = data.sites.twitter;
    expect(tw).toHaveProperty('totalPosts', 42);
    expect(tw).toHaveProperty('uniqueAuthors', 10);
    expect(tw).toHaveProperty('oldestPost');
    expect(tw).toHaveProperty('newestPost');
    expect(tw).toHaveProperty('lastCollected');
    expect(tw.lastCollected).toHaveProperty('following');
    expect(tw).toHaveProperty('capabilities');
    expect(tw.capabilities).toContain('auth');
    expect(tw.capabilities).toContain('feed');
  });

  it('stats resource template returns single site', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const tmpl = resourceTemplates.find(
      (r) => r.uriTemplate === 'site-use://stats/{site}'
    );
    expect(tmpl).toBeDefined();

    const result = await client.readResource({ uri: 'site-use://stats/twitter' });
    const data = JSON.parse((result.contents[0] as any).text);

    // server block still present
    expect(data.server.version).toBeDefined();

    // only the requested site
    expect(Object.keys(data.sites)).toEqual(['twitter']);
    expect(data.sites.twitter.totalPosts).toBe(42);
    expect(data.sites.twitter.capabilities).toContain('feed');
  });

  it('stats resource template returns empty sites for unknown site', async () => {
    const result = await client.readResource({ uri: 'site-use://stats/reddit' });
    const data = JSON.parse((result.contents[0] as any).text);
    expect(data.sites).toEqual({});
    expect(data.server.plugins).toContain('twitter');
  });
});
