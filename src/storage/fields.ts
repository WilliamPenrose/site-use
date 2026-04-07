import type { SearchField, SearchResultItem } from './types.js';

// Fields that are always kept regardless of --fields selection.
const ALWAYS_KEEP = new Set(['id', 'site']);

/**
 * Filter output fields on items using a whitelist approach.
 * Only `id`, `site`, and explicitly requested fields are kept — everything else is removed.
 * When fields is undefined or empty, returns items unchanged.
 */
export function applyFieldsFilter(
  items: SearchResultItem[],
  fields: SearchField[] | undefined,
): SearchResultItem[] {
  if (!fields || fields.length === 0) return items;

  const keep = new Set<string>([...ALWAYS_KEEP, ...fields]);

  // siteMeta is handled specially — not added to keep set.
  // When text is requested, we include a trimmed siteMeta (metrics only, no quotedTweet).
  // When text is NOT requested but author is, preserve following=false tag only.

  return items
    .map((item) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(item)) {
        if (keep.has(key)) filtered[key] = val;
      }
      // siteMeta handling: trim to scalar metrics only (no nested objects like quotedTweet)
      if (item.siteMeta) {
        const meta = item.siteMeta as Record<string, unknown>;
        if (keep.has('text')) {
          // Keep only scalar values (numbers, booleans, strings)
          const trimmed: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(meta)) {
            if (v !== null && typeof v !== 'object') trimmed[k] = v;
          }
          if (Object.keys(trimmed).length > 0) filtered.siteMeta = trimmed;
        } else if (keep.has('author') && meta.following === false) {
          filtered.siteMeta = { following: false };
        }
      }
      return filtered as unknown as SearchResultItem;
    })
    .filter((item) => {
      // Drop items where no requested field survived projection.
      // We can't compare against ALWAYS_KEEP.size because not every item carries
      // every always-keep key (e.g. feed items lack `site`). Instead, count keys
      // that are not in ALWAYS_KEEP — at least one must remain.
      for (const key of Object.keys(item)) {
        if (!ALWAYS_KEEP.has(key)) return true;
      }
      return false;
    });
}
