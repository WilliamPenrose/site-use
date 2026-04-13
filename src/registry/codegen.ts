import { z, type ZodType } from 'zod';
import type { SitePlugin, ActionWorkflow } from './types.js';
import type { SiteRuntimeManager } from '../runtime/manager.js';
import { wrapToolHandler } from './tool-wrapper.js';
import path from 'node:path';
import os from 'node:os';
import { unwrapToolResult, writeOutput } from './cli-output.js';
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
        const wrappedWf = wrapToolHandler({
          siteName: plugin.name,
          toolName: `${plugin.name}_${wf.name}`,
          getRuntime: () => runtimeManager.get(plugin.name),
          onBrowserDisconnected: () => runtimeManager.clearAll(),
          paramsSchema: wf.params,
          handler: async (params, runtime, trace) => {
            return await wf.execute(runtime.primitives, params, trace);
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

            const { stdoutFlag, outputPath, pluginArgs } = stripOutputFlags(remainingArgs);
            const params = parseCliArgs(pluginArgs, wf.params);

            if (dumpRawDir) {
              (params as Record<string, unknown>).dumpRaw = dumpRawDir;
            }

            // ── Execute ──
            const data = unwrapToolResult(await wrappedWf(params));
            if (data === null) return;  // error already printed

            // ── Output ──
            writeOutput(data, {
              stdout: stdoutFlag,
              outputPath,
              siteName: plugin.name,
              workflowName: wf.name,
            });

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

export function stripOutputFlags(
  args: string[],
): { stdoutFlag: boolean; outputPath?: string; pluginArgs: string[] } {
  let stdoutFlag = false;
  let outputPath: string | undefined;
  const pluginArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--stdout':
        stdoutFlag = true;
        i++;
        break;
      case '--output': {
        outputPath = args[i + 1];
        if (!outputPath || outputPath.startsWith('--')) {
          throw new Error('--output requires a file path');
        }
        i += 2;
        break;
      }
      default:
        pluginArgs.push(arg);
        i++;
    }
  }
  return { stdoutFlag, outputPath, pluginArgs };
}

function buildWorkflowHelp(
  siteName: string,
  wf: { name: string; kind?: string; dumpRaw?: boolean; cli?: { description?: string; help?: string } },
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

    lines.push('Output options:');
    lines.push('  --stdout               Full JSON output to stdout');
    lines.push('  --output <path>        Write output to specific file path');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Extract the field-name → ZodType shape from a schema, unwrapping
 * ZodEffects layers (.refine/.transform/.superRefine) to reach the inner ZodObject.
 */
function getSchemaShape(schema: ZodType): Record<string, ZodType> | null {
  let current: ZodType = schema;
  // Unwrap ZodEffects (from .refine / .transform / .superRefine)
  while (current instanceof z.ZodEffects) {
    current = (current as z.ZodEffects<any>)._def.schema;
  }
  if (current instanceof z.ZodObject) {
    return (current as z.ZodObject<any>).shape;
  }
  return null;
}

/** Check if a Zod field type is (or wraps) a number, unwrapping ZodDefault/ZodOptional. */
function isNumberField(field: ZodType): boolean {
  let current = field;
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional) {
    current = current._def.innerType;
  }
  return current instanceof z.ZodNumber;
}

/**
 * Minimal CLI arg parser: converts --flag value pairs to object,
 * then validates against the Zod schema.
 *
 * Schema-aware: only coerces values to numbers when the target field
 * is z.number(). All other values are kept as strings for Zod to validate.
 */
function parseCliArgs(args: string[], schema: ZodType): Record<string, unknown> {
  const shape = getSchemaShape(schema);
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
        // Only coerce to number when the schema field is a number type
        const field = shape?.[key];
        if (field && isNumberField(field)) {
          const num = Number(next);
          raw[key] = isNaN(num) ? next : num;
        } else {
          raw[key] = next;
        }
        i += 2;
      }
    } else {
      i++;
    }
  }
  return schema.parse(raw);
}
