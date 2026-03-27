import type { KnowledgeStore } from '../../storage/index.js';
import type { FeedItem, FeedResult } from '../../registry/types.js';

export async function twitterLocalQuery(
  store: KnowledgeStore,
  params: unknown,
): Promise<FeedResult> {
  const { count, tab } = (params ?? {}) as { count?: number; tab?: string };
  const result = await store.search({
    site: 'twitter',
    max_results: count ?? 20,
    ...(tab === 'following' && {
      metricFilters: [{ metric: 'following', op: '=' as const, numValue: 1 }],
    }),
  });
  const items = result.items.map(row => JSON.parse(row.rawJson!) as FeedItem);
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
