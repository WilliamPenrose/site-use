import path from 'node:path';
import { checkFreshness } from './freshness.js';
import { setLastFetchTime } from '../fetch-timestamps.js';
import { SEARCH_FIELDS, type SearchField } from '../storage/types.js';

export interface SmartCacheOptions {
  siteName: string;
  variant: string;        // e.g. "for_you", "following", "r/programming"
  maxAge: number;         // minutes
  forceLocal: boolean;
  forceFetch: boolean;
  dataDir: string;
}

export interface SmartCacheHandlers<T> {
  localQuery: () => Promise<T>;
  remoteFetch: () => Promise<T>;
  hasLocalData: () => Promise<boolean>;
}

export interface SmartCacheResult<T> {
  result: T;
  source: 'local' | 'remote';
  ageMinutes?: number;
}

export async function withSmartCache<T>(
  opts: SmartCacheOptions,
  handlers: SmartCacheHandlers<T>,
): Promise<SmartCacheResult<T>> {
  if (opts.forceLocal) {
    if (!(await handlers.hasLocalData())) {
      throw new Error(
        `No local data found for "${opts.siteName}". Run without --local first to populate the cache.`,
      );
    }
    const freshness = checkFreshness(opts.dataDir, opts.siteName, opts.variant, opts.maxAge);
    const result = await handlers.localQuery();
    return { result, source: 'local', ageMinutes: freshness.ageMinutes };
  }

  if (opts.forceFetch) {
    const result = await handlers.remoteFetch();
    updateTimestamp(opts);
    return { result, source: 'remote' };
  }

  // Auto mode
  const freshness = checkFreshness(opts.dataDir, opts.siteName, opts.variant, opts.maxAge);

  if (freshness.shouldFetch || !(await handlers.hasLocalData())) {
    const result = await handlers.remoteFetch();
    updateTimestamp(opts);
    return { result, source: 'remote' };
  }

  const result = await handlers.localQuery();
  return { result, source: 'local', ageMinutes: freshness.ageMinutes };
}

function updateTimestamp(opts: SmartCacheOptions): void {
  const tsPath = path.join(opts.dataDir, 'fetch-timestamps.json');
  setLastFetchTime(tsPath, opts.siteName, opts.variant);
}

export interface CacheFlags {
  forceLocal: boolean;
  forceFetch: boolean;
  maxAge: number;
}

export function stripFrameworkFlags(
  args: string[],
  defaultMaxAge: number,
): { cacheFlags: CacheFlags; pluginArgs: string[]; fields: SearchField[] | undefined } {
  const cacheFlags: CacheFlags = {
    forceLocal: false,
    forceFetch: false,
    maxAge: defaultMaxAge,
  };
  const pluginArgs: string[] = [];
  let fields: SearchField[] | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--local':
        cacheFlags.forceLocal = true;
        i++;
        break;
      case '--fetch':
        cacheFlags.forceFetch = true;
        i++;
        break;
      case '--max-age': {
        const val = parseInt(args[i + 1], 10);
        if (isNaN(val)) throw new Error(`Invalid --max-age value: "${args[i + 1]}"`);
        cacheFlags.maxAge = val;
        i += 2;
        break;
      }
      case '--fields': {
        const parts = args[i + 1].split(',');
        const invalid = parts.filter((f) => !(SEARCH_FIELDS as readonly string[]).includes(f));
        if (invalid.length > 0) throw new Error(`Unknown field(s): ${invalid.join(', ')}`);
        fields = parts as SearchField[];
        i += 2;
        break;
      }
      default:
        pluginArgs.push(arg);
        i++;
    }
  }

  if (cacheFlags.forceLocal && cacheFlags.forceFetch) {
    throw new Error('--fetch and --local are mutually exclusive.');
  }

  return { cacheFlags, pluginArgs, fields };
}
