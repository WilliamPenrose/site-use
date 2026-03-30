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
import { applyFieldsFilter } from '../storage/fields.js';
import { SEARCH_FIELDS } from '../storage/types.js';
import type { SearchResultItem } from '../storage/types.js';
import fs from 'node:fs';
import type { Trace } from '../trace.js';

function shouldExposeCli(expose?: Array<'mcp' | 'cli'>): boolean {
  if (!expose) return true;
  return expose.includes('cli');
}

// ── CLI command generation ─────────────────────────────────

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
    const { workflows } = plugin;

    if (plugin.auth && shouldExposeCli(plugin.auth.expose)) {
      const authCheck = plugin.auth.check;
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
        description: plugin.auth.cli?.description
          ?? `Check login status for ${plugin.name}`,
        handler: async (args) => {
          if (args?.includes('--help') || args?.includes('-h')) {
            const desc = plugin.auth!.cli?.description ?? `Check login status for ${plugin.name}`;
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

    if (workflows) {
      for (const wf of workflows) {
        if (!shouldExposeCli(wf.expose)) continue;

        const hasCacheSupport = !!(wf.localQuery && wf.cache);
        const hasCacheOnly = !!(wf.cache && !wf.localQuery);

        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          toolName: `${plugin.name}_${wf.name}`,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          autoIngest: plugin.storeAdapter
            ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[]) => any[] }, siteName: plugin.name }
            : undefined,
          handler: async (params, runtime, trace) => {
            const result = await wf.execute(runtime.primitives, params, trace);
            if (wf.cache) {
              const cfg = getConfig();
              const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
              const variant = wf.cache.variantKey
                ? ((params as Record<string, unknown>)[wf.cache.variantKey] as string | undefined) ?? wf.cache.defaultVariant ?? 'default'
                : wf.cache.defaultVariant ?? 'default';
              setLastFetchTime(tsPath, plugin.name, variant);
            }
            return result;
          },
        });

        commands.push({
          site: plugin.name,
          command: wf.name,
          description: wf.cli?.description ?? wf.description,
          handler: async (args) => {
            if (args?.includes('--help') || args?.includes('-h')) {
              console.log(buildWorkflowHelp(plugin.name, wf));
              return;
            }

            // Extract --dump-raw if workflow declares it
            let remainingArgs = args;
            let dumpRawDir: string | null = null;
            let isDefaultDir = false;
            if (wf.dumpRaw) {
              const extracted = extractDumpRaw(args, plugin.name);
              remainingArgs = extracted.remainingArgs;
              dumpRawDir = extracted.dumpRawDir;
              isDefaultDir = extracted.isDefaultDir;

              if (dumpRawDir && isDefaultDir) {
                rotateDumpFiles(dumpRawDir);
              }
            }

            if (hasCacheSupport || hasCacheOnly) {
              const { cacheFlags, pluginArgs, fields } = stripFrameworkFlags(remainingArgs, wf.cache!.defaultMaxAge);

              // --dump-raw + --local are mutually exclusive
              if (dumpRawDir && cacheFlags.forceLocal) {
                throw new Error('--dump-raw and --local are mutually exclusive.');
              }
              // --dump-raw implies --fetch
              if (dumpRawDir) {
                cacheFlags.forceFetch = true;
              }

              const params = parseCliArgs(pluginArgs, wf.params);
              if (dumpRawDir) {
                (params as Record<string, unknown>).dumpRaw = dumpRawDir;
              }

              const variantKey = wf.cache!.variantKey;
              const variant = variantKey
                ? ((params as Record<string, unknown>)[variantKey] as string | undefined) ?? wf.cache!.defaultVariant ?? 'default'
                : wf.cache!.defaultVariant ?? 'default';

              const cfg = getConfig();
              const dbPath = getKnowledgeDbPath(cfg.dataDir);

              if (hasCacheSupport) {
                // Full smart-cache with --local support
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
                        return await wf.localQuery!(store, params);
                      } finally {
                        store.close();
                      }
                    },
                    remoteFetch: async () => {
                      const result = await wrappedWf(params);
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

                let output = localizeTimestamps(cacheResult.result) as Record<string, unknown>;
                if (fields && Array.isArray(output.items)) {
                  output = { ...output, items: applyFieldsFilter(output.items as SearchResultItem[], fields) };
                }

                if (cacheFlags.quiet) {
                  const items = Array.isArray(output.items) ? output.items : [];
                  const meta = output.meta as { timeRange?: { from?: string; to?: string } } | undefined;
                  const from = meta?.timeRange?.from ?? '';
                  const to = meta?.timeRange?.to ?? '';
                  const timeStr = from && to
                    ? ` ${from.replace('T', ' ').slice(0, 25)} ~ ${to.replace('T', ' ').slice(11, 25)}`
                    : '';
                  if (cacheResult.source === 'local') {
                    const age = cacheResult.ageMinutes != null ? `${cacheResult.ageMinutes}min old` : 'age unknown';
                    console.error(`Using cached data (${age}). ${items.length} items in cache.`);
                  } else {
                    console.error(`Synced ${items.length} items (${variant},${timeStr}).`);
                  }
                } else {
                  console.log(JSON.stringify(output, null, 2));
                  if (cacheResult.source === 'local') {
                    const age = cacheResult.ageMinutes != null ? `${cacheResult.ageMinutes}min old` : 'age unknown';
                    console.error(`Using cached data (${age}).`);
                  } else {
                    console.error('Fetched from browser.');
                  }
                }
              } else {
                // Cache without localQuery — always fetches, respects --fetch / --max-age
                const result = await wrappedWf(params);
                const text = (result.content[0] as { text: string }).text;
                if (result.isError) {
                  console.log(text);
                  process.exitCode = 1;
                } else {
                  let noCacheOutput = localizeTimestamps(JSON.parse(text)) as Record<string, unknown>;
                  if (fields && Array.isArray(noCacheOutput.items)) {
                    noCacheOutput = { ...noCacheOutput, items: applyFieldsFilter(noCacheOutput.items as SearchResultItem[], fields) };
                  }
                  if (cacheFlags.quiet) {
                    const items = Array.isArray(noCacheOutput.items) ? noCacheOutput.items : [];
                    const meta = noCacheOutput.meta as { timeRange?: { from?: string; to?: string } } | undefined;
                    const from = meta?.timeRange?.from ?? '';
                    const to = meta?.timeRange?.to ?? '';
                    const timeStr = from && to
                      ? ` ${from.replace('T', ' ').slice(0, 25)} ~ ${to.replace('T', ' ').slice(11, 25)}`
                      : '';
                    console.error(`Synced ${items.length} items (default,${timeStr}).`);
                  } else {
                    console.log(JSON.stringify(noCacheOutput, null, 2));
                  }
                }
              }

              if (dumpRawDir) {
                console.error(`Dumped to ${dumpRawDir}`);
              }
            } else {
              // No cache — simple direct execution
              const { pluginArgs: wfPluginArgs, fields: wfFields } = stripFrameworkFlags(remainingArgs, 120);
              const params = parseCliArgs(wfPluginArgs, wf.params);
              if (dumpRawDir) {
                (params as Record<string, unknown>).dumpRaw = dumpRawDir;
              }

              const result = await wrappedWf(params);
              const text = (result.content[0] as { text: string }).text;
              if (result.isError) {
                console.log(text);
                process.exitCode = 1;
              } else {
                let wfOutput = localizeTimestamps(JSON.parse(text)) as Record<string, unknown>;
                if (wfFields && Array.isArray(wfOutput.items)) {
                  wfOutput = { ...wfOutput, items: applyFieldsFilter(wfOutput.items as SearchResultItem[], wfFields) };
                }
                console.log(JSON.stringify(wfOutput, null, 2));
              }

              if (dumpRawDir) {
                console.error(`Dumped to ${dumpRawDir}`);
              }
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

function buildWorkflowHelp(
  siteName: string,
  wf: { name: string; cache?: { defaultMaxAge: number }; localQuery?: unknown; dumpRaw?: boolean; cli?: { description?: string; help?: string } },
): string {
  const lines: string[] = [];
  const desc = wf.cli?.description ?? wf.name;
  lines.push(`site-use ${siteName} ${wf.name} — ${desc}\n`);

  if (wf.cli?.help) {
    lines.push(wf.cli.help);
    lines.push('');
  }

  if (wf.dumpRaw) {
    lines.push('Dump options:');
    lines.push('  --dump-raw [dir]       Dump raw responses to directory (default: ~/.site-use/dump/{site}/)');
    lines.push('');
  }

  if (wf.cache) {
    lines.push('Cache options:');
    if (wf.localQuery) {
      lines.push('  --local                Force local cache query (no browser)');
    }
    lines.push('  --fetch                Force fetch from browser (skip freshness check)');
    lines.push(`  --max-age <minutes>    Max cache age before auto-fetching (default: ${wf.cache.defaultMaxAge})`);
    lines.push('');
  }

  lines.push('Output options:');
  lines.push(`  --fields <list>        Comma-separated fields: ${SEARCH_FIELDS.join(',')}`);
  lines.push('  --quiet, -q            Suppress JSON output, show one-line summary only');
  lines.push('');

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
