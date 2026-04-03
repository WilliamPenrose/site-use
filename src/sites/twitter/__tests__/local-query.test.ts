import { describe, it, expect, vi } from 'vitest';
import { twitterLocalQuery } from '../local-query.js';
import type { KnowledgeStore } from '../../../storage/index.js';

function createMockStore(items: Array<{ rawJson: string; metrics?: Array<{ metric: string; numValue?: number; strValue?: string }> }>): KnowledgeStore {
  return {
    search: vi.fn().mockResolvedValue({ items }),
  } as unknown as KnowledgeStore;
}

function makeFeedItemJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '1', author: { handle: 'test', name: 'Test' },
    text: 'hello', timestamp: '2026-01-01', url: 'https://x.com/test/status/1',
    media: [], links: [], siteMeta: {},
    ...overrides,
  });
}

describe('twitterLocalQuery', () => {
  it('filters by source_tab when available', async () => {
    const store = createMockStore([
      { rawJson: makeFeedItemJson({ id: '1' }), metrics: [{ metric: 'source_tab', strValue: 'vibe coding' }] },
      { rawJson: makeFeedItemJson({ id: '2' }), metrics: [{ metric: 'source_tab', strValue: 'for_you' }] },
    ]);

    const result = await twitterLocalQuery(store, { tab: 'vibe coding' });
    expect(store.search).toHaveBeenCalledWith(expect.objectContaining({
      metricFilters: expect.arrayContaining([
        { metric: 'source_tab', op: '=', strValue: 'vibe coding' },
      ]),
    }));
  });

  it('falls back to author.following for tab=following when source_tab returns empty', async () => {
    const store = {
      search: vi.fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [{ rawJson: makeFeedItemJson() }] }),
    } as unknown as KnowledgeStore;

    const result = await twitterLocalQuery(store, { tab: 'following' });
    expect(store.search).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
  });

  it('returns all cached data for for_you tab (default behavior)', async () => {
    const store = createMockStore([
      { rawJson: makeFeedItemJson({ id: '1' }) },
      { rawJson: makeFeedItemJson({ id: '2' }) },
    ]);

    const result = await twitterLocalQuery(store, { tab: 'for_you' });
    expect(store.search).toHaveBeenCalledWith(expect.objectContaining({
      metricFilters: expect.arrayContaining([
        { metric: 'source_tab', op: '=', strValue: 'for_you' },
      ]),
    }));
  });

  it('returns empty for non-well-known tab with no source_tab data', async () => {
    const store = createMockStore([]);
    const result = await twitterLocalQuery(store, { tab: 'vibe coding' });
    expect(result.items).toHaveLength(0);
  });
});
