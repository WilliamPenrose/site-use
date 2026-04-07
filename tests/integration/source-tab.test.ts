import { describe, it, expect, afterEach } from 'vitest';
import { createStore } from '../../src/storage/index.js';
import { registerDisplaySchema } from '../../src/storage/query.js';
import { twitterDisplaySchema } from '../../src/sites/twitter/display.js';
import type { KnowledgeStore } from '../../src/storage/types.js';

let store: KnowledgeStore;
afterEach(() => store?.close());

function makeItem(id: string, sourceTabs: string[] | undefined) {
  return {
    site: 'twitter',
    id,
    text: `tweet ${id}`,
    author: 'alice',
    timestamp: '2026-04-07T10:00:00Z',
    url: `https://x.com/alice/status/${id}`,
    rawJson: JSON.stringify({
      id,
      author: { handle: 'alice', name: 'Alice' },
      text: `tweet ${id}`,
      siteMeta: {},
    }),
    sourceTabs,
  };
}

describe('source_tab multi-membership', () => {
  it('persists sourceTabs to item_source_tabs table', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');
    await store.ingest([makeItem('1', ['for_you'])]);

    const result = await store.search({
      site: 'twitter',
      sourceTab: 'for_you',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('1');
  });

  it('records the same item under multiple tabs across separate ingests', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');

    // First ingest under for_you
    await store.ingest([makeItem('shared', ['for_you'])]);
    // Second ingest of the same item under vibe coding
    await store.ingest([makeItem('shared', ['vibe coding'])]);

    const forYouResult = await store.search({ site: 'twitter', sourceTab: 'for_you' });
    const vibeResult = await store.search({ site: 'twitter', sourceTab: 'vibe coding' });

    expect(forYouResult.items.map(i => i.id)).toContain('shared');
    expect(vibeResult.items.map(i => i.id)).toContain('shared');
  });

  it('returns empty when sourceTab does not match any row', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');
    await store.ingest([makeItem('1', ['for_you'])]);

    const result = await store.search({
      site: 'twitter',
      sourceTab: 'nonexistent',
    });
    expect(result.items).toHaveLength(0);
  });

  it('ingest without sourceTabs writes only to items table', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');
    await store.ingest([makeItem('orphan', undefined)]);

    const result = await store.search({ site: 'twitter', sourceTab: 'for_you' });
    expect(result.items).toHaveLength(0);
  });

  it('ingest with empty sourceTabs array writes nothing to item_source_tabs', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');
    await store.ingest([makeItem('empty', [])]);

    const result = await store.search({ site: 'twitter', sourceTab: 'for_you' });
    expect(result.items).toHaveLength(0);
  });

  it('clean removes related rows from item_source_tabs', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');

    // Two items both tagged with vibe coding
    await store.ingest([
      makeItem('keep', ['vibe coding']),
      makeItem('drop', ['vibe coding']),
    ]);

    // Sanity: both visible via sourceTab query
    const before = await store.search({ site: 'twitter', sourceTab: 'vibe coding' });
    expect(before.items.map(i => i.id).sort()).toEqual(['drop', 'keep']);

    // Delete all items by author 'alice'; verify item_source_tabs rows are gone
    // (no FK constraint failure, and the query returns nothing)
    await store.deleteItems({ site: 'twitter', author: 'alice' });

    const after = await store.search({ site: 'twitter', sourceTab: 'vibe coding' });
    expect(after.items).toHaveLength(0);
  });

  it('combines sourceTab with hashtag filter using AND semantics', async () => {
    registerDisplaySchema('twitter', twitterDisplaySchema);
    store = createStore(':memory:');

    // Item 1: #AI from for_you
    await store.ingest([{
      ...makeItem('1', ['for_you']),
      text: 'tweet about #AI',
      hashtags: ['ai'],
    }]);
    // Item 2: #AI from vibe coding (the only match)
    await store.ingest([{
      ...makeItem('2', ['vibe coding']),
      text: 'another #AI tweet',
      hashtags: ['ai'],
    }]);
    // Item 3: #ML from vibe coding (matches sourceTab but not hashtag)
    await store.ingest([{
      ...makeItem('3', ['vibe coding']),
      text: 'tweet about #ML',
      hashtags: ['ml'],
    }]);

    const result = await store.search({
      site: 'twitter',
      sourceTab: 'vibe coding',
      hashtag: 'ai',
    });

    expect(result.items.map(i => i.id)).toEqual(['2']);
  });
});
