import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeStore, SearchParams, SearchResult } from '../../src/storage/index.js';
import type { FeedItem } from '../../src/registry/types.js';
import { twitterLocalQuery } from '../../src/sites/twitter/local-query.js';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const fakeFeedItem: FeedItem = {
  id: '1',
  author: { handle: 'testuser', name: 'Test' },
  text: 'hello',
  timestamp: '2026-03-27T10:00:00Z',
  url: 'https://x.com/testuser/status/1',
  media: [],
  links: [],
  siteMeta: { likes: 5 },
};

const fakeFeedItem2: FeedItem = {
  id: '2',
  author: { handle: 'otheruser', name: 'Other' },
  text: 'world',
  timestamp: '2026-03-27T09:00:00Z',
  url: 'https://x.com/otheruser/status/2',
  media: [],
  links: [],
  siteMeta: { likes: 10, following: true },
};

const fakeFeedItem3: FeedItem = {
  id: '3',
  author: { handle: 'testuser', name: 'Test' },
  text: 'latest tweet',
  timestamp: '2026-03-27T11:00:00Z',
  url: 'https://x.com/testuser/status/3',
  media: [],
  links: [],
  siteMeta: { likes: 3 },
};

function makeSearchResult(items: FeedItem[]): SearchResult {
  return {
    items: items.map(item => ({
      id: item.id,
      site: 'twitter',
      rawJson: JSON.stringify(item),
      text: item.text,
      author: item.author.handle,
      timestamp: item.timestamp,
      url: item.url,
    })),
  };
}

function makeStore(searchFn: (params: SearchParams) => Promise<SearchResult>): KnowledgeStore {
  return {
    search: searchFn,
    ingest: vi.fn(),
    countItems: vi.fn(),
    statsBySite: vi.fn(),
    rebuild: vi.fn(),
    deleteItems: vi.fn(),
    previewDelete: vi.fn(),
    exportItems: vi.fn(),
    close: vi.fn(),
  } as unknown as KnowledgeStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('twitterLocalQuery', () => {
  it('returns FeedResult with items parsed from rawJson', async () => {
    const store = makeStore(async () => makeSearchResult([fakeFeedItem, fakeFeedItem2]));

    const result = await twitterLocalQuery(store, {});

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(fakeFeedItem);
    expect(result.items[1]).toEqual(fakeFeedItem2);
  });

  it('passes sourceTab filter for tab=following (single-layer, no fallback)', async () => {
    const searchSpy = vi.fn().mockResolvedValue(makeSearchResult([fakeFeedItem2]));
    const store = makeStore(searchSpy);

    const result = await twitterLocalQuery(store, { tab: 'following' });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][0].sourceTab).toBe('following');
    expect(result.items).toHaveLength(1);
  });

  it('passes sourceTab filter for tab=for_you (single-layer, no fallback)', async () => {
    const searchSpy = vi.fn().mockResolvedValue(makeSearchResult([fakeFeedItem, fakeFeedItem2]));
    const store = makeStore(searchSpy);

    const result = await twitterLocalQuery(store, { tab: 'for_you' });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][0].sourceTab).toBe('for_you');
    expect(result.items).toHaveLength(2);
  });

  it('defaults to sourceTab=for_you when tab is absent', async () => {
    const searchSpy = vi.fn(async (_params: SearchParams) => makeSearchResult([fakeFeedItem]));
    const store = makeStore(searchSpy);

    await twitterLocalQuery(store, {});

    expect(searchSpy.mock.calls[0][0].sourceTab).toBe('for_you');
  });

  it('uses count param as max_results (defaults to 20)', async () => {
    const searchSpy = vi.fn(async (_params: SearchParams) => makeSearchResult([fakeFeedItem]));
    const store = makeStore(searchSpy);

    await twitterLocalQuery(store, { count: 5 });

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ max_results: 5 }),
    );

    searchSpy.mockClear();
    searchSpy.mockResolvedValue(makeSearchResult([]));
    await twitterLocalQuery(store, {});
    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ max_results: 20 }),
    );
  });

  it('computes timeRange from item timestamps', async () => {
    const store = makeStore(async () =>
      makeSearchResult([fakeFeedItem, fakeFeedItem2, fakeFeedItem3]),
    );

    const result = await twitterLocalQuery(store, {});

    // timestamps: 10:00, 09:00, 11:00 — sorted: 09:00, 10:00, 11:00
    expect(result.meta.timeRange.from).toBe('2026-03-27T09:00:00Z');
    expect(result.meta.timeRange.to).toBe('2026-03-27T11:00:00Z');
  });

  it('computes coveredUsers as unique author handles', async () => {
    const store = makeStore(async () =>
      makeSearchResult([fakeFeedItem, fakeFeedItem2, fakeFeedItem3]),
    );

    const result = await twitterLocalQuery(store, {});

    // fakeFeedItem and fakeFeedItem3 share handle 'testuser'; fakeFeedItem2 is 'otheruser'
    expect(result.meta.coveredUsers).toHaveLength(2);
    expect(result.meta.coveredUsers).toContain('testuser');
    expect(result.meta.coveredUsers).toContain('otheruser');
  });

  it('returns empty timeRange when no items', async () => {
    const store = makeStore(async () => makeSearchResult([]));

    const result = await twitterLocalQuery(store, {});

    expect(result.items).toHaveLength(0);
    expect(result.meta.timeRange.from).toBe('');
    expect(result.meta.timeRange.to).toBe('');
    expect(result.meta.coveredUsers).toHaveLength(0);
  });
});
