import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { discoverPlugins } from './registry/discovery.js';
import { generateMcpTools } from './registry/codegen.js';
import { SiteRuntimeManager } from './runtime/manager.js';
import { registerGlobalTools } from './server-global-tools.js';
import { BUILD_HASH, BUILD_DATE } from './build-info.js';

function getVersion(): string {
  if (BUILD_HASH === 'dev') return 'dev';
  return `${BUILD_DATE}+${BUILD_HASH}`;
}

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'site-use',
    version: getVersion(),
  });

  // Discover all plugins (built-in + external), validate
  const plugins = await discoverPlugins();

  // Create runtime manager (lazy per-site isolation)
  const runtimeManager = new SiteRuntimeManager(plugins);

  // Generate and register site-specific MCP tools
  const tools = generateMcpTools(plugins, runtimeManager);
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

  // Register global tools (screenshot, search, stats)
  registerGlobalTools(server, runtimeManager);

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
