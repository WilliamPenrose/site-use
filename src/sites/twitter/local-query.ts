import type { KnowledgeStore } from '../../storage/index.js';
import type { FeedItem, FeedResult } from '../../registry/types.js';

export async function twitterLocalQuery(
  store: KnowledgeStore,
  params: unknown,
): Promise<FeedResult> {
  const { count, tab } = (params ?? {}) as { count?: number; tab?: string };
  const maxResults = count ?? 20;

  // Layer 1: Try source_tab metric filter
  const sourceTabResult = await store.search({
    site: 'twitter',
    max_results: maxResults,
    metricFilters: [{ metric: 'source_tab', op: '=' as const, strValue: tab ?? 'for_you' }],
  });

  let items: FeedItem[];

  if (sourceTabResult.items.length > 0) {
    items = sourceTabResult.items.map(row => JSON.parse(row.rawJson!) as FeedItem);
  } else if (tab === 'following') {
    // Layer 2: Fallback for historical data without source_tab
    const fallbackResult = await store.search({
      site: 'twitter',
      max_results: maxResults,
      metricFilters: [{ metric: 'following', op: '=' as const, numValue: 1 }],
    });
    items = fallbackResult.items.map(row => JSON.parse(row.rawJson!) as FeedItem);
  } else if (!tab || tab === 'for_you') {
    // Layer 2 (for_you): return all cached tweets — backwards compatible with pre-upgrade data
    const allResult = await store.search({
      site: 'twitter',
      max_results: maxResults,
    });
    items = allResult.items.map(row => JSON.parse(row.rawJson!) as FeedItem);
  } else {
    // Non-well-known tab with no source_tab data — no fallback available
    items = [];
  }

  const timestamps = items.map(i => i.timestamp).filter(Boolean).sort();
  return {
    items,
    meta: {
      coveredUsers: [...new Set(items.map(i => i.author.handle))],
      timeRange: {
        from: timestamps[0] ?? '',
        to: timestamps[timestamps.length - 1] ?? '',
      },
    },
  };
}
