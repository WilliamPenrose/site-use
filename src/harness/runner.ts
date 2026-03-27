// src/harness/runner.ts
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../storage/schema.js';
import { ingest } from '../storage/ingest.js';
import { search } from '../storage/query.js';
import { resolveItem } from '../display/resolve.js';
import type { FeedItem } from '../registry/types.js';
import type { SearchResultItem } from '../storage/types.js';
import type {
  SiteHarnessDescriptor,
  DomainDescriptor,
  AssertionFn,
  AssertionContext,
  LayerResult,
  VariantResult,
  HarnessReport,
} from './types.js';

/**
 * Match assertion functions from a tag-keyed registry against a variant string.
 * '*' matches all non-tombstone variants. Other keys match if the variant string
 * contains the key as a substring.
 */
export function matchAssertions(
  registry: Record<string, AssertionFn[]>,
  variant: string,
): AssertionFn[] {
  const matched: AssertionFn[] = [];
  for (const [tag, fns] of Object.entries(registry)) {
    if (tag === '*') {
      // Wildcard matches all non-tombstone variants
      if (!variant.startsWith('tombstone')) {
        matched.push(...fns);
      }
    } else if (variant.includes(tag)) {
      matched.push(...fns);
    }
  }
  return matched;
}

/**
 * Run a single variant through the full pipeline (Layer 0-5).
 * Uses an in-memory SQLite DB for Layer 3-4b to ensure isolation.
 */
export async function runVariant(
  descriptor: SiteHarnessDescriptor,
  domainName: string,
  variant: string,
): Promise<VariantResult> {
  const domain = descriptor.domains[domainName];
  if (!domain) {
    return {
      variant,
      pass: false,
      failedLayer: 'Layer 0→1',
      message: `Domain "${domainName}" not found in descriptor`,
      layers: [],
    };
  }

  const layers: LayerResult[] = [];

  // Layer 0→1: parseEntry
  let parsed: unknown;
  try {
    parsed = domain.parseEntry(variant);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 0→1', pass: false, errors: [message] });
    return { variant, pass: false, failedLayer: 'Layer 0→1', message, layers };
  }

  // Tombstone: parseEntry returned null → pass, stop
  if (parsed === null || parsed === undefined) {
    layers.push({ layer: 'Layer 0→1 (tombstone)', pass: true, output: null, errors: [] });
    return { variant, pass: true, layers };
  }

  layers.push({ layer: 'Layer 0→1', pass: true, output: parsed, errors: [] });

  // Layer 1→2: toFeedItem
  let feedItem: FeedItem;
  try {
    feedItem = domain.toFeedItem(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 1→2', pass: false, errors: [message] });
    return { variant, pass: false, failedLayer: 'Layer 1→2', message, layers };
  }
  layers.push({ layer: 'Layer 1→2', pass: true, output: feedItem, errors: [] });

  // Layer 2 assertions: domain assertions on FeedItem
  const domainAssertions = matchAssertions(domain.assertions, variant);
  if (domainAssertions.length > 0) {
    const errors: string[] = [];
    for (const assertFn of domainAssertions) {
      const ctx: AssertionContext = { variant, layer: 2, input: parsed, output: feedItem };
      const result = assertFn(ctx);
      if (!result.pass) {
        errors.push(result.message ?? 'Assertion failed');
      }
    }
    if (errors.length > 0) {
      layers.push({ layer: 'Layer 2 assertions', pass: false, errors });
      return { variant, pass: false, failedLayer: 'Layer 2 assertions', message: errors[0], layers };
    }
    layers.push({ layer: 'Layer 2 assertions', pass: true, errors: [] });
  }

  // Layer 2→3: storeAdapter
  let ingestItems;
  try {
    ingestItems = descriptor.storeAdapter([feedItem]);
    if (!ingestItems || ingestItems.length === 0) {
      layers.push({ layer: 'Layer 2→3', pass: false, errors: ['storeAdapter returned empty'] });
      return { variant, pass: false, failedLayer: 'Layer 2→3', message: 'storeAdapter returned empty', layers };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 2→3', pass: false, errors: [message] });
    return { variant, pass: false, failedLayer: 'Layer 2→3', message, layers };
  }
  layers.push({ layer: 'Layer 2→3', pass: true, output: ingestItems, errors: [] });

  // Layer 3→4a: ingest into in-memory DB
  let db: DatabaseSync | undefined;
  try {
    db = initializeDatabase(':memory:');
    ingest(db, ingestItems);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 3→4a', pass: false, errors: [message] });
    db?.close();
    return { variant, pass: false, failedLayer: 'Layer 3→4a', message, layers };
  }
  layers.push({ layer: 'Layer 3→4a', pass: true, errors: [] });

  // Layer 4a→4b: search back from DB
  let searchItem: SearchResultItem;
  try {
    const site = ingestItems[0].site;
    const author = ingestItems[0].author;
    const searchResult = search(db, { site, author });

    if (!searchResult.items || searchResult.items.length === 0) {
      layers.push({ layer: 'Layer 4a→4b', pass: false, errors: ['search returned empty'] });
      db.close();
      return { variant, pass: false, failedLayer: 'Layer 4a→4b', message: 'search returned empty', layers };
    }

    searchItem = searchResult.items[0];

    // Resolve siteMeta from raw_json using descriptor's displaySchema if not already resolved
    if (!searchItem.siteMeta && descriptor.displaySchema) {
      const rawJson = JSON.parse(ingestItems[0].rawJson) as Record<string, unknown>;
      const fields = Object.keys(descriptor.displaySchema);
      const display = resolveItem(rawJson, descriptor.displaySchema, fields);
      if (Object.keys(display).length > 0) {
        searchItem.siteMeta = display;
      }
    }

    // Check siteMeta not empty
    if (!searchItem.siteMeta || Object.keys(searchItem.siteMeta).length === 0) {
      layers.push({ layer: 'Layer 4a→4b', pass: false, errors: ['siteMeta is empty'] });
      db.close();
      return { variant, pass: false, failedLayer: 'Layer 4a→4b', message: 'siteMeta is empty', layers };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 4a→4b', pass: false, errors: [message] });
    db.close();
    return { variant, pass: false, failedLayer: 'Layer 4a→4b', message, layers };
  }
  layers.push({ layer: 'Layer 4a→4b', pass: true, output: searchItem, errors: [] });
  db.close();

  // Layer 5: formatFn
  let formatted: string;
  try {
    formatted = descriptor.formatFn(searchItem);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layers.push({ layer: 'Layer 5', pass: false, errors: [message] });
    return { variant, pass: false, failedLayer: 'Layer 5', message, layers };
  }
  layers.push({ layer: 'Layer 5', pass: true, output: formatted, errors: [] });

  // Layer 5 assertions: format assertions on formatted text
  const formatAssertions = matchAssertions(descriptor.formatAssertions, variant);
  if (formatAssertions.length > 0) {
    const errors: string[] = [];
    for (const assertFn of formatAssertions) {
      const ctx: AssertionContext = { variant, layer: 5, input: searchItem, output: formatted };
      const result = assertFn(ctx);
      if (!result.pass) {
        errors.push(result.message ?? 'Format assertion failed');
      }
    }
    if (errors.length > 0) {
      layers.push({ layer: 'Layer 5 assertions', pass: false, errors });
      return { variant, pass: false, failedLayer: 'Layer 5 assertions', message: errors[0], layers };
    }
    layers.push({ layer: 'Layer 5 assertions', pass: true, errors: [] });
  }

  return { variant, pass: true, layers };
}

/**
 * Run all variants for a domain and return a HarnessReport.
 */
export async function runDomain(
  descriptor: SiteHarnessDescriptor,
  site: string,
  domainName: string,
  variants: string[],
  source: 'golden' | 'captured' | 'quarantine',
): Promise<HarnessReport> {
  const results: VariantResult[] = [];
  for (const variant of variants) {
    const result = await runVariant(descriptor, domainName, variant);
    results.push(result);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  return {
    site,
    domain: domainName,
    source,
    totalVariants: variants.length,
    passed,
    failed,
    results,
  };
}

/**
 * Dynamic import of a site's harness descriptor.
 * Returns the descriptor or null if the module doesn't exist.
 */
export async function loadHarness(site: string): Promise<SiteHarnessDescriptor | null> {
  try {
    const mod = await import(`../sites/${site}/harness.js`);
    return (mod.default ?? mod.descriptor ?? null) as SiteHarnessDescriptor | null;
  } catch {
    return null;
  }
}
