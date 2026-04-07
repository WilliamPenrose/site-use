import { z, type ZodType } from 'zod';
import type { SitePlugin, CollectionWorkflow, ActionWorkflow } from './types.js';
import type { SiteRuntimeManager } from '../runtime/manager.js';
import { wrapToolHandler } from './tool-wrapper.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { getConfig, getKnowledgeDbPath } from '../config.js';
import path from 'node:path';
import os from 'node:os';
import { withSmartCache, stripFrameworkFlags } from '../cli/smart-cache.js';
import { createStore } from '../storage/index.js';
import { SEARCH_FIELDS } from '../storage/types.js';
import { unwrapToolResult, formatCliOutput } from './cli-output.js';
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

        const isAction = wf.kind === 'action';
        const isQuery = wf.kind === 'query';
        const hasCacheSupport = wf.kind === 'collection' && !!((wf as CollectionWorkflow).localQuery && (wf as CollectionWorkflow).cache);

        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          toolName: `${plugin.name}_${wf.name}`,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          autoIngest: plugin.storeAdapter
            ? { storeAdapter: plugin.storeAdapter as { toIngestItems: (items: any[], context?: Record<string, unknown>) => any[] }, siteName: plugin.name }
            : undefined,
          handler: async (params, runtime, trace) => {
            const result = await wf.execute(runtime.primitives, params, trace);
            if (wf.kind === 'collection' && (wf as CollectionWorkflow).cache) {
              const cacheConfig = (wf as CollectionWorkflow).cache!;
              const cfg = getConfig();
              const tsPath = path.join(cfg.dataDir, 'fetch-timestamps.json');
              const variant = cacheConfig.variantKey
                ? ((params as Record<string, unknown>)[cacheConfig.variantKey] as string | undefined) ?? cacheConfig.defaultVariant ?? 'default'
                : cacheConfig.defaultVariant ?? 'default';
              setLastFetchTime(tsPath, plugin.name, variant);
            }
            return result;
          },
          actionOpts: isAction ? {
            dailyLimit: (wf as ActionWorkflow).dailyLimit,
            dailyLimitKey: (wf as ActionWorkflow).dailyLimitKey,
          } : undefined,
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

            if (isAction || isQuery) {
              const params = parseCliArgs(args, wf.params);
              const result = unwrapToolResult(await wrappedWf(params));
              if (result === null) return;
              console.log(JSON.stringify(result, null, 2));
              return;
            }

            // ── Pre-processing (shared by all paths) ──────────
            let remainingArgs = args;
            let dumpRawDir: string | null = null;
            let isDefaultDir = false;
            if (wf.dumpRaw) {
              const extracted = extractDumpRaw(args, plugin.name);
              remainingArgs = extracted.remainingArgs;
              dumpRawDir = extracted.dumpRawDir;
              isDefaultDir = extracted.isDefaultDir;
              if (dumpRawDir && isDefaultDir) rotateDumpFiles(dumpRawDir);
            }

            const { cacheFlags, pluginArgs, fields } = stripFrameworkFlags(
              remainingArgs,
              wf.cache?.defaultMaxAge ?? 120,
            );
            const params = parseCliArgs(pluginArgs, wf.params);

            if (dumpRawDir) {
              if (cacheFlags.forceLocal) throw new Error('--dump-raw and --local are mutually exclusive.');
              cacheFlags.forceFetch = true;
              (params as Record<string, unknown>).dumpRaw = dumpRawDir;
            }

            const variantKey = wf.cache?.variantKey;
            const variant = variantKey
              ? ((params as Record<string, unknown>)[variantKey] as string | undefined) ?? wf.cache!.defaultVariant ?? 'default'
              : wf.cache?.defaultVariant ?? 'default';

            // ── Data fetch ────────────────────────────────────
            let data: unknown;
            let source: 'local' | 'remote' | undefined;
            let ageMinutes: number | undefined;

            if (hasCacheSupport) {
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
                    try { return await wf.localQuery!(store, params); }
                    finally { store.close(); }
                  },
                  remoteFetch: async () => {
                    const result = await wrappedWf(params);
                    const unwrapped = unwrapToolResult(result);
                    if (unwrapped === null) throw new Error('tool returned error');
                    return unwrapped;
                  },
                  hasLocalData: async () => {
                    if (!fs.existsSync(dbPath)) return false;
                    const store = createStore(dbPath);
                    try { return (await store.countItems({ site: plugin.name })) > 0; }
                    catch { return false; }
                    finally { store.close(); }
                  },
                },
              );
              data = cacheResult.result;
              source = cacheResult.source;
              ageMinutes = cacheResult.ageMinutes;
            } else {
              data = unwrapToolResult(await wrappedWf(params));
              if (data === null) return;  // error already printed to stdout + exitCode set
            }

            // ── Output ────────────────────────────────────────
            // source is undefined for non-cache paths → no stderr hint (preserves original behavior)
            formatCliOutput(data, { fields, quiet: cacheFlags.quiet, source, ageMinutes, variant });

            if (dumpRawDir) console.error(`Dumped to ${dumpRawDir}`);
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
  wf: { name: string; kind?: string; cache?: { defaultMaxAge: number }; localQuery?: unknown; dumpRaw?: boolean; cli?: { description?: string; help?: string } },
): string {
  const lines: string[] = [];
  const desc = wf.cli?.description ?? wf.name;
  lines.push(`site-use ${siteName} ${wf.name} — ${desc}\n`);

  if (wf.cli?.help) {
    lines.push(wf.cli.help);
    lines.push('');
  }

  if (wf.kind === 'collection') {
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
