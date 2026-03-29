import type { SearchField, SearchResultItem } from './types.js';

/**
 * Filter output fields on SearchResultItem[].
 * When fields is undefined or empty, returns items unchanged.
 * Works on any items shaped like SearchResultItem (search results, feed output, tweet_detail).
 */
export function applyFieldsFilter(
  items: SearchResultItem[],
  fields: SearchField[] | undefined,
): SearchResultItem[] {
  if (!fields || fields.length === 0) return items;

  const f = new Set(fields);
  for (const item of items) {
    if (!f.has('text')) {
      delete item.text;
      // Preserve following=false when author is requested (shows [not following] tag)
      const following = (item.siteMeta as Record<string, unknown> | undefined)?.following;
      if (following === false && f.has('author')) {
        item.siteMeta = { following };
      } else {
        delete item.siteMeta;
      }
    }
    if (!f.has('author')) delete item.author;
    if (!f.has('url')) delete item.url;
    if (!f.has('timestamp')) delete item.timestamp;
    if (!f.has('links')) delete item.links;
    if (!f.has('mentions')) delete item.mentions;
    if (!f.has('media')) delete item.media;
  }
  return items.filter(item => Object.keys(item).length > 2);
}
