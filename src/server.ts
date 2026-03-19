import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'site-use',
    version: '0.1.0',
  });

  // Tool registration will be added in subsequent capabilities.
  // M1 tools: twitter_check_login, twitter_timeline, screenshot

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
