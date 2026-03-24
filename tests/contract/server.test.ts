import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Primitives } from '../../src/primitives/types.js';
import { createServer, _setPrimitivesForTest } from '../../src/server.js';

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(),
  isBrowserConnected: vi.fn().mockReturnValue(true),
}));

function createMockPrimitives(): Primitives {
  return {
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
}

describe('MCP Server contract', () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const mock = createMockPrimitives();
    _setPrimitivesForTest({ guarded: mock, throttled: mock });
    server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    _setPrimitivesForTest(null);
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
    expect(props.min_likes).toBeDefined();
    expect(props.min_retweets).toBeDefined();
    expect(props.fields).toBeDefined();
    expect((props.fields as any).items.enum).toEqual(
      expect.arrayContaining(['author', 'text', 'url', 'timestamp', 'likes', 'retweets', 'replies', 'views'])
    );
  });

  it('screenshot tool returns image content', async () => {
    const result = await client.callTool({ name: 'screenshot', arguments: {} });
    const content = result.content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('image');
    expect(content[0].mimeType).toBe('image/png');
    expect(typeof content[0].data).toBe('string');
  });
});
