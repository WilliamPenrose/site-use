import { z, type ZodType } from 'zod';
import type { SitePlugin } from './types.js';
import type { SiteRuntimeManager } from '../runtime/manager.js';
import { wrapToolHandler } from './tool-wrapper.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { localizeTimestamps } from '../format-date.js';
import { getConfig, getKnowledgeDbPath } from '../config.js';
import path from 'node:path';
import os from 'node:os';
import { withSmartCache, stripFrameworkFlags } from '../cli/smart-cache.js';
import { createStore } from '../storage/index.js';
import fs from 'node:fs';
import type { Trace } from '../trace.js';

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
});

function shouldExposeCli(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true;
  return expose.includes('cli');
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
        toolName: `${plugin.name}_check_login`,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        handler: async (_params, runtime, _trace) => authCheck(runtime.primitives),
      });
      commands.push({
        site: plugin.name,
        command: 'check-login',
        description: capabilities.auth.cli?.description
          ?? `Check login status for ${plugin.name}`,
        handler: async (args) => {
          if (args?.includes('--help') || args?.includes('-h')) {
            const desc = capabilities.auth!.cli?.description ?? `Check login status for ${plugin.name}`;
            console.log(`site-use ${plugin.name} check-login — ${desc}\n`);
            return;
          }
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
      const feedCap = capabilities.feed;
      const wrappedFeed = wrapToolHandler({
        siteName: plugin.name,
        toolName: `${plugin.name}_feed`,
        getRuntime: () => runtimeManager.get(plugin.name),
        onBrowserDisconnected: () => runtimeManager.clearAll(),
        paramsSchema,
        resultSchema: FeedResultSchema,
        autoIngest: plugin.storeAdapter
          ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[]) => any[] }, siteName: plugin.name }
          : undefined,
        handler: async (params, runtime, trace) => {
          const result = await feedCollect(runtime.primitives, params, trace);
          const cfg = getConfig();
          const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
          const tab = (params as Record<string, unknown>).tab as string | undefined;
          setLastFetchTime(tsPath, plugin.name, tab ?? 'default');
          return result;
        },
      });

      const hasCacheSupport = !!(feedCap.localQuery && feedCap.cache);

      commands.push({
        site: plugin.name,
        command: 'feed',
        description: feedCap.cli?.description
          ?? `Collect feed from ${plugin.name}`,
        handler: async (args) => {
          if (args?.includes('--help') || args?.includes('-h')) {
            console.log(buildFeedHelp(
              plugin.name,
              feedCap.cli,
              hasCacheSupport,
              feedCap.cache?.defaultMaxAge,
            ));
            return;
          }

          // Extract --dump-raw before any branch
          const { dumpRawDir, isDefaultDir, remainingArgs } = extractDumpRaw(args, plugin.name);

          if (hasCacheSupport) {
            const { cacheFlags, pluginArgs } = stripFrameworkFlags(remainingArgs, feedCap.cache!.defaultMaxAge);

            // --dump-raw + --local are mutually exclusive
            if (dumpRawDir && cacheFlags.forceLocal) {
              throw new Error('--dump-raw and --local are mutually exclusive.');
            }
            // --dump-raw implies --fetch
            if (dumpRawDir) {
              cacheFlags.forceFetch = true;
            }

            // Backup rotation (default dir only)
            if (dumpRawDir && isDefaultDir) {
              rotateDumpFiles(dumpRawDir);
            }

            const params = parseCliArgs(pluginArgs, paramsSchema);
            if (dumpRawDir) {
              (params as Record<string, unknown>).dumpRaw = dumpRawDir;
            }

            const variantKey = feedCap.cache!.variantKey;
            const variant = variantKey
              ? ((params as Record<string, unknown>)[variantKey] as string | undefined) ?? feedCap.cache!.defaultVariant ?? 'default'
              : feedCap.cache!.defaultVariant ?? 'default';

            const cfg = getConfig();
            const dbPath = getKnowledgeDbPath(cfg.dataDir);

            const cacheResult = await withSmartCache(
              {
                siteName: plugin.name,
                variant,
                maxAge: cacheFlags.maxAge,
                forceLocal: cacheFlags.forceLocal,
                forceFetch: cacheFlags.forceFetch,
                dataDir: cfg.dataDir,
              },
              {
                localQuery: async () => {
                  const store = createStore(dbPath);
                  try {
                    return await feedCap.localQuery!(store, params);
                  } finally {
                    store.close();
                  }
                },
                remoteFetch: async () => {
                  const result = await wrappedFeed(params);
                  if (result.isError) {
                    const text = (result.content[0] as { text: string }).text;
                    throw new Error(text);
                  }
                  return JSON.parse((result.content[0] as { text: string }).text);
                },
                hasLocalData: async () => {
                  if (!fs.existsSync(dbPath)) return false;
                  const store = createStore(dbPath);
                  try {
                    const count = await store.countItems({ site: plugin.name });
                    return count > 0;
                  } catch {
                    return false;
                  } finally {
                    store.close();
                  }
                },
              },
            );

            console.log(JSON.stringify(localizeTimestamps(cacheResult.result), null, 2));
            if (cacheResult.source === 'local') {
              const age = cacheResult.ageMinutes != null ? `${cacheResult.ageMinutes}min old` : 'age unknown';
              console.error(`Using cached data (${age}).`);
            } else {
              console.error('Fetched from browser.');
            }

            if (dumpRawDir) {
              console.error(`Dumped to ${dumpRawDir}`);
            }
          } else {
            // No cache support — always fetches
            if (dumpRawDir && isDefaultDir) {
              rotateDumpFiles(dumpRawDir);
            }

            const params = parseCliArgs(remainingArgs, paramsSchema);
            if (dumpRawDir) {
              (params as Record<string, unknown>).dumpRaw = dumpRawDir;
            }

            const result = await wrappedFeed(params);
            const text = (result.content[0] as { text: string }).text;
            if (result.isError) {
              console.log(text);
              process.exitCode = 1;
            } else {
              console.log(JSON.stringify(localizeTimestamps(JSON.parse(text)), null, 2));
            }

            if (dumpRawDir) {
              console.error(`Dumped to ${dumpRawDir}`);
            }
          }
        },
      });
    }

    if (customWorkflows) {
      for (const wf of customWorkflows) {
        if (!shouldExposeCli(wf.expose)) continue;
        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          toolName: `${plugin.name}_${wf.name}`,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          autoIngest: plugin.storeAdapter
            ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[]) => any[] }, siteName: plugin.name }
            : undefined,
          handler: async (params, runtime, trace) => wf.execute(runtime.primitives, params, trace),
        });
        commands.push({
          site: plugin.name,
          command: wf.name,
          description: wf.cli?.description ?? wf.description,
          handler: async (args) => {
            if (args?.includes('--help') || args?.includes('-h')) {
              const desc = wf.cli?.description ?? wf.description;
              console.log(`site-use ${plugin.name} ${wf.name} — ${desc}\n`);
              if (wf.cli?.help) {
                console.log(wf.cli.help);
              }
              return;
            }
            const params = parseCliArgs(args, wf.params);
            const result = await wrappedWf(params);
            const text = (result.content[0] as { text: string }).text;
            if (result.isError) {
              console.log(text);
              process.exitCode = 1;
            } else {
              console.log(JSON.stringify(localizeTimestamps(JSON.parse(text)), null, 2));
            }
          },
        });
      }
    }
  }

  return commands;
}

export interface DumpRawResult {
  dumpRawDir: string | null;
  isDefaultDir: boolean;
  remainingArgs: string[];
}

export function extractDumpRaw(args: string[], siteName: string): DumpRawResult {
  const remainingArgs: string[] = [];
  let dumpRawDir: string | null = null;
  let isDefaultDir = false;

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--dump-raw') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        dumpRawDir = next;
        isDefaultDir = false;
        i += 2;
      } else {
        const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
        dumpRawDir = path.join(dataDir, 'dump', siteName);
        isDefaultDir = true;
        i++;
      }
    } else {
      remainingArgs.push(args[i]);
      i++;
    }
  }

  return { dumpRawDir, isDefaultDir, remainingArgs };
}

function rotateDumpFiles(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.prev.json'));
  for (const file of files) {
    const src = path.join(dir, file);
    const dest = path.join(dir, file.replace(/\.json$/, '.prev.json'));
    fs.renameSync(src, dest);
  }
}

function buildFeedHelp(
  siteName: string,
  cli: { description?: string; help?: string } | undefined,
  hasCacheSupport: boolean,
  defaultMaxAge?: number,
): string {
  const lines: string[] = [];
  const desc = cli?.description ?? `Collect feed from ${siteName}`;
  lines.push(`site-use ${siteName} feed — ${desc}\n`);

  if (cli?.help) {
    lines.push(cli.help);
    lines.push('');
  }

  lines.push('Dump options:');
  lines.push('  --dump-raw [dir]       Dump raw responses to directory (default: ~/.site-use/dump/{site}/)');
  lines.push('');

  if (hasCacheSupport) {
    lines.push('Cache options:');
    lines.push('  --local                Force local cache query (no browser)');
    lines.push('  --fetch                Force fetch from browser (skip freshness check)');
    lines.push(`  --max-age <minutes>    Max cache age before auto-fetching (default: ${defaultMaxAge ?? 120})`);
    lines.push('');
  }

  return lines.join('\n');
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
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
