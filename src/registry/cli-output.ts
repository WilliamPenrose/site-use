import type { ToolResult } from './tool-wrapper.js';
import { localizeTimestamps } from '../format-date.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Extract and parse the JSON payload from a ToolResult.
 * On error: prints the error text to stdout and sets process.exitCode = 1.
 * Returns null on error so the caller can short-circuit.
 */
export function unwrapToolResult(result: ToolResult): unknown | null {
  const text = (result.content[0] as { text: string }).text;
  if (result.isError) {
    console.log(text);
    process.exitCode = 1;
    return null;
  }
  return JSON.parse(text);
}

export interface WriteOutputOptions {
  stdout: boolean;
  outputPath?: string;
  siteName: string;
  workflowName: string;
}

/**
 * Output pipeline for collection workflows:
 * - Localize timestamps
 * - If --stdout: full JSON to stdout
 * - Otherwise: write to file, print summary to stdout
 */
export function writeOutput(data: unknown, opts: WriteOutputOptions): void {
  const localized = localizeTimestamps(data);

  if (opts.stdout) {
    console.log(JSON.stringify(localized, null, 2));
    return;
  }

  const outputPath = opts.outputPath ?? defaultOutputPath(opts.siteName, opts.workflowName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(localized, null, 2));

  const items = (localized as Record<string, unknown>).items;
  const count = Array.isArray(items) ? items.length : 0;
  console.log(JSON.stringify({ count, file: outputPath }));
}

function defaultOutputPath(siteName: string, workflowName: string): string {
  const dataDir = process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return path.join(dataDir, 'output', siteName, `${workflowName}-${timestamp}.json`);
}
