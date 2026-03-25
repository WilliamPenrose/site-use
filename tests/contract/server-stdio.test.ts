/**
 * Smoke test: MCP server stays alive over stdio and responds to requests.
 *
 * Unlike server.test.ts (InMemoryTransport), this spawns the real entry point
 * as a child process and talks to it via StdioClientTransport — the same path
 * Claude Desktop / Cursor / any MCP host would use.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const ENTRY = path.resolve(__dirname, '../../dist/index.js');

describe('MCP Server stdio smoke test', () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  afterEach(async () => {
    try { await client?.close(); } catch {}
    client = null;
    transport = null;
  });

  it('starts over stdio, lists tools, and shuts down cleanly', async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [ENTRY, 'mcp'],
    });
    client = new Client({ name: 'smoke-test', version: '1.0.0' });

    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe('site-use');

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(4);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('twitter_check_login');
    expect(toolNames).toContain('twitter_feed');
    expect(toolNames).toContain('screenshot');
    expect(toolNames).toContain('search');
  }, 10_000);
});
