import type { ToolResult } from './tool-wrapper.js';
import { localizeTimestamps } from '../format-date.js';
import { applyFieldsFilter } from '../storage/fields.js';
import type { SearchResultItem, SearchField } from '../storage/types.js';

/**
 * Extract and parse the JSON payload from a ToolResult.
 * On error: prints the error text to stdout and sets process.exitCode = 1,
 * matching the original codegen inline error handling behavior.
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

export interface FormatCliOutputOptions {
  fields?: SearchField[];
  quiet: boolean;
  /** 'local' | 'remote' for cache paths; undefined for non-cache paths (no stderr hint). */
  source?: 'local' | 'remote';
  ageMinutes?: number;
  variant?: string;
}

/**
 * Unified CLI output pipeline:
 * 1. Localize timestamps
 * 2. Apply fields filter (if specified)
 * 3. Output JSON to stdout (normal) or one-line summary to stderr (quiet)
 * 4. Show source hint on stderr
 */
export function formatCliOutput(data: unknown, opts: FormatCliOutputOptions): void {
  let output = localizeTimestamps(data) as Record<string, unknown>;

  if (opts.fields && Array.isArray(output.items)) {
    output = { ...output, items: applyFieldsFilter(output.items as SearchResultItem[], opts.fields) };
  }

  if (opts.quiet) {
    const items = Array.isArray(output.items) ? output.items : [];
    const meta = output.meta as { timeRange?: { from?: string; to?: string } } | undefined;
    const from = meta?.timeRange?.from ?? '';
    const to = meta?.timeRange?.to ?? '';
    const timeStr = from && to
      ? ` ${from.replace('T', ' ').slice(0, 25)} ~ ${to.replace('T', ' ').slice(11, 25)}`
      : '';
    const variant = opts.variant ?? 'default';

    if (opts.source === 'local') {
      const age = opts.ageMinutes != null ? `${opts.ageMinutes}min old` : 'age unknown';
      console.error(`Using cached data (${age}). ${items.length} items in cache.`);
    } else {
      console.error(`Synced ${items.length} items (${variant},${timeStr}).`);
    }
  } else {
    console.log(JSON.stringify(output, null, 2));

    if (opts.source === 'local') {
      const age = opts.ageMinutes != null ? `${opts.ageMinutes}min old` : 'age unknown';
      console.error(`Using cached data (${age}).`);
    } else if (opts.source === 'remote') {
      console.error('Fetched from browser.');
    }
    // source undefined (no-cache path) → no stderr hint
  }
}
