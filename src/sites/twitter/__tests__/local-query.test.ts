import { describe, it, expect, vi } from 'vitest';
import { twitterLocalQuery } from '../local-query.js';
import type { KnowledgeStore } from '../../../storage/index.js';

function createMockStore(items: Array<{ rawJson: string }>): KnowledgeStore {
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
  it('passes the requested tab through as sourceTab filter', async () => {
    const store = createMockStore([
      { rawJson: makeFeedItemJson({ id: '1' }) },
    ]);
    await twitterLocalQuery(store, { tab: 'vibe coding' });
    expect(store.search).toHaveBeenCalledWith(expect.objectContaining({
      site: 'twitter',
      sourceTab: 'vibe coding',
    }));
  });

  it('defaults to for_you when tab is omitted', async () => {
    const store = createMockStore([]);
    await twitterLocalQuery(store, {});
    expect(store.search).toHaveBeenCalledWith(expect.objectContaining({
      sourceTab: 'for_you',
    }));
  });

  it('returns empty result for an unknown tab without throwing (no Layer 2 fallback)', async () => {
    const store = createMockStore([]);
    const result = await twitterLocalQuery(store, { tab: 'nonexistent_tab' });
    expect(result.items).toEqual([]);
    expect(store.search).toHaveBeenCalledTimes(1);  // No fallback call
  });

  it('parses rawJson into FeedItems', async () => {
    const store = createMockStore([
      { rawJson: makeFeedItemJson({ id: '7', author: { handle: 'alice' } }) },
    ]);
    const result = await twitterLocalQuery(store, { tab: 'for_you' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('7');
    expect(result.items[0].author.handle).toBe('alice');
  });

  it('respects count parameter via max_results', async () => {
    const store = createMockStore([]);
    await twitterLocalQuery(store, { tab: 'for_you', count: 50 });
    expect(store.search).toHaveBeenCalledWith(expect.objectContaining({
      max_results: 50,
    }));
  });
});
