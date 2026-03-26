import { z, type ZodType, type ZodRawShape } from 'zod';
import type { SitePlugin } from './types.js';
import type { SiteRuntimeManager } from '../runtime/manager.js';
import { wrapToolHandler, type ToolResult } from './tool-wrapper.js';
import { DEFAULT_TOOL_DESCRIPTIONS } from './default-descriptions.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { getConfig } from '../config.js';
import path from 'node:path';

// ── FeedResult Zod schema for return value validation ──────────
const MediaItemSchema = z.object({
  type: z.string(), url: z.string(), width: z.number(), height: z.number(),
  duration: z.number().optional(), thumbnailUrl: z.string().optional(),
});
const FeedItemSchema = z.object({
  id: z.string(), author: z.object({ handle: z.string(), name: z.string() }),
  text: z.string(), timestamp: z.string(), url: z.string(),
  media: z.array(MediaItemSchema), links: z.array(z.string()),
  siteMeta: z.record(z.unknown()),
});
const FeedResultSchema = z.object({
  items: z.array(FeedItemSchema),
  meta: z.object({
    coveredUsers: z.array(z.string()),
    timeRange: z.object({ from: z.string(), to: z.string() }),
  }),
  debug: z.record(z.unknown()).optional(),
});

// ── MCP Tool generation ────────────────────────────────────────

export interface GeneratedMcpTool {
  name: string;
  config: {
    description: string;
    inputSchema?: ZodRawShape;
  };
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

function shouldExposeMcp(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true;
  return expose.includes('mcp');
}

function shouldExposeCli(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true;
  return expose.includes('cli');
}

export function generateMcpTools(
  plugins: SitePlugin[],
  runtimeManager: SiteRuntimeManager,
): GeneratedMcpTool[] {
  const tools: GeneratedMcpTool[] = [];

  for (const plugin of plugins) {
    const { capabilities, customWorkflows } = plugin;

    if (capabilities?.auth && shouldExposeMcp(capabilities.auth.expose)) {
      const description = capabilities.auth.description
        ?? DEFAULT_TOOL_DESCRIPTIONS.auth(plugin.name);
      const authCheck = capabilities.auth.check;

      tools.push({
        name: `${plugin.name}_check_login`,
        config: { description },
        handler: wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          handler: async (_params, runtime) => {
            return await authCheck(runtime.primitives);
          },
        }),
      });
    }

    if (capabilities?.feed && shouldExposeMcp(capabilities.feed.expose)) {
      const description = capabilities.feed.description
        ?? DEFAULT_TOOL_DESCRIPTIONS.feed(plugin.name);
      const feedCollect = capabilities.feed.collect;
      const paramsSchema = capabilities.feed.params;

      const inputSchema = extractZodShape(paramsSchema);

      tools.push({
        name: `${plugin.name}_feed`,
        config: { description, inputSchema },
        handler: wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema,
          resultSchema: FeedResultSchema,
          autoIngest: plugin.storeAdapter
            ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[]) => any[] }, siteName: plugin.name }
            : undefined,
          handler: async (params, runtime) => {
            const result = await feedCollect(runtime.primitives, params);

            const cfg = getConfig();
            const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
            const tab = (params as Record<string, unknown>).tab as string | undefined;
            setLastFetchTime(tsPath, plugin.name, tab ?? 'default');

            return result;
          },
        }),
      });
    }

    if (customWorkflows) {
      for (const wf of customWorkflows) {
        if (!shouldExposeMcp(wf.expose)) continue;

        const inputSchema = extractZodShape(wf.params);

        tools.push({
          name: `${plugin.name}_${wf.name}`,
          config: { description: wf.description, inputSchema },
          handler: wrapToolHandler({
            siteName: plugin.name,
            getRuntime: () => runtimeManager.get(plugin.name),
            onBrowserDisconnected: () => runtimeManager.clearAll(),
            paramsSchema: wf.params,
            handler: async (params, runtime) => {
              return await wf.execute(runtime.primitives, params);
            },
          }),
        });
      }
    }
  }

  return tools;
}

/** Extract the raw shape from a ZodObject for MCP SDK's inputSchema. */
function extractZodShape(schema: ZodType): ZodRawShape | undefined {
  if (!schema) return undefined;
  if ('shape' in schema && typeof schema.shape === 'object') {
    return schema.shape as ZodRawShape;
  }
  return undefined;
}

// ── CLI command generation ─────────────────────────────────────

export interface GeneratedCliCommand {
  site: string;
  command: string;
  description: string;
  handler: (args: string[]) => Promise<void>;
}

export function generateCliCommands(
  plugins: SitePlugin[],
  runtimeManager: SiteRuntimeManager,
): GeneratedCliCommand[] {
  const commands: GeneratedCliCommand[] = [];

  for (const plugin of plugins) {
    const { capabilities, customWorkflows } = plugin;

    if (capabilities?.auth && shouldExposeCli(capabilities.auth.expose)) {
      const authCheck = capabilities.auth.check;
      const wrappedAuth = wrapToolHandler({
        siteName: plugin.name,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        handler: async (_params, runtime) => authCheck(runtime.primitives),
      });
      commands.push({
        site: plugin.name,
        command: 'check-login',
        description: capabilities.auth.cli?.description
          ?? `Check login status for ${plugin.name}`,
        handler: async () => {
          const result = await wrappedAuth({});
          const text = (result.content[0] as { text: string }).text;
          console.log(text);
          if (result.isError) process.exitCode = 1;
        },
      });
    }

    if (capabilities?.feed && shouldExposeCli(capabilities.feed.expose)) {
      const feedCollect = capabilities.feed.collect;
      const paramsSchema = capabilities.feed.params;
      const wrappedFeed = wrapToolHandler({
        siteName: plugin.name,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        paramsSchema,
        resultSchema: FeedResultSchema,
        autoIngest: plugin.storeAdapter
          ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[]) => any[] }, siteName: plugin.name }
          : undefined,
        handler: async (params, runtime) => {
          const result = await feedCollect(runtime.primitives, params);
          const cfg = getConfig();
          const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
          const tab = (params as Record<string, unknown>).tab as string | undefined;
          setLastFetchTime(tsPath, plugin.name, tab ?? 'default');
          return result;
        },
      });
      commands.push({
        site: plugin.name,
        command: 'feed',
        description: capabilities.feed.cli?.description
          ?? `Collect feed from ${plugin.name}`,
        handler: async (args) => {
          const params = parseCliArgs(args, paramsSchema);
          const result = await wrappedFeed(params);
          const text = (result.content[0] as { text: string }).text;
          console.log(text);
          if (result.isError) process.exitCode = 1;
        },
      });
    }

    if (customWorkflows) {
      for (const wf of customWorkflows) {
        if (!shouldExposeCli(wf.expose)) continue;
        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          handler: async (params, runtime) => wf.execute(runtime.primitives, params),
        });
        commands.push({
          site: plugin.name,
          command: wf.name,
          description: wf.cli?.description ?? wf.description,
          handler: async (args) => {
            const params = parseCliArgs(args, wf.params);
            const result = await wrappedWf(params);
            const text = (result.content[0] as { text: string }).text;
            console.log(text);
            if (result.isError) process.exitCode = 1;
          },
        });
      }
    }
  }

  return commands;
}

/**
 * Minimal CLI arg parser: converts --flag value pairs to object,
 * then validates against the Zod schema.
 */
function parseCliArgs(args: string[], schema: ZodType): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        raw[key] = true;
        i++;
      } else {
        const num = Number(next);
        raw[key] = isNaN(num) ? next : num;
        i += 2;
      }
    } else {
      i++;
    }
  }
  return schema.parse(raw);
}
