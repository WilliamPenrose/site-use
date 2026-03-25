import { describe, it, expect, afterEach } from 'vitest';
import { createStore } from '../../src/storage/index.js';
import type { KnowledgeStore } from '../../src/storage/types.js';
import { tweetsToIngestItems } from '../../src/sites/twitter/store-adapter.js';
import type { Tweet } from '../../src/sites/twitter/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let store: KnowledgeStore;

afterEach(() => {
  store?.close();
});

describe('storage integration', () => {
  it('full flow: ingest → search → stats', async () => {
    store = createStore(':memory:');

    const ingestResult = await store.ingest([{
      site: 'twitter',
      id: '42',
      text: 'Integration test tweet about AI agents',
      author: 'testbot',
      timestamp: '2026-03-20T10:00:00Z',
      url: 'https://x.com/testbot/status/42',
      rawJson: JSON.stringify({
        author: { handle: 'testbot', name: 'Test Bot', following: true },
        text: 'Integration test tweet about AI agents',
        metrics: { likes: 10, retweets: 2 },
        media: [],
        links: ['https://example.com/post'],
        isRetweet: false,
        isAd: false,
      }),
      mentions: ['someone'],
      hashtags: ['ai'],
      metrics: [
        { metric: 'likes', numValue: 10 },
        { metric: 'retweets', numValue: 2 },
      ],
    }]);
    expect(ingestResult.inserted).toBe(1);

    const searchResult = await store.search({ query: 'AI agents' });
    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0].author).toBe('testbot');

    const authorResult = await store.search({ author: 'testbot' });
    expect(authorResult.items).toHaveLength(1);

    const hashResult = await store.search({ hashtag: 'ai' });
    expect(hashResult.items).toHaveLength(1);

    // links come from raw_json now
    const item = searchResult.items[0];
    expect(item.links).toEqual(['https://example.com/post']);

    const s = await store.stats();
    expect(s.totalItems).toBe(1);
    expect(s.bySite).toEqual({ twitter: 1 });
    expect(s.uniqueAuthors).toBe(1);
  });

  it('dedup across multiple ingest calls', async () => {
    store = createStore(':memory:');

    const item = {
      site: 'twitter', id: '99', text: 'Dedup test', author: 'a',
      timestamp: '2026-03-20T10:00:00Z', url: 'https://x.com/a/status/99',
      rawJson: JSON.stringify({ author: { handle: 'a', name: 'A', following: true }, text: 'Dedup test', metrics: {}, media: [], links: [] }),
      mentions: [] as string[], hashtags: [] as string[],
    };

    await store.ingest([item]);
    const result = await store.ingest([item]);
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1);

    const s = await store.stats();
    expect(s.totalItems).toBe(1);
  });

  it('ingests following metric', async () => {
    store = createStore(':memory:');
    const tweet: Tweet = {
      id: 'follow-test',
      author: { handle: 'alice', name: 'Alice', following: true },
      text: 'test tweet',
      timestamp: '2026-03-25T12:00:00Z',
      url: 'https://x.com/alice/status/follow-test',
      metrics: { likes: 1 },
      media: [],
      links: [],
      isRetweet: false,
      isAd: false,
      surfaceReason: 'original',
    };
    const items = tweetsToIngestItems([tweet]);
    await store.ingest(items);
    const result = await store.search({
      site: 'twitter',
      metricFilters: [{ metric: 'following', op: '=', numValue: 1 }],
    });
    expect(result.items).toHaveLength(1);
  });

  it('concurrent read/write via WAL mode (file-based db)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    store = undefined as unknown as KnowledgeStore;

    try {
      const writer = createStore(dbPath);
      const reader = createStore(dbPath);

      await writer.ingest([{
        site: 'twitter', id: 'wal1', text: 'WAL concurrency test', author: 'tester',
        timestamp: '2026-03-20T10:00:00Z', url: 'https://x.com/tester/status/wal1',
        rawJson: JSON.stringify({ author: { handle: 'tester', name: 'Tester', following: true }, text: 'WAL concurrency test', metrics: {}, media: [], links: [] }),
        mentions: [] as string[], hashtags: [] as string[],
      }]);

      const result = await reader.search({ author: 'tester' });
      expect(result.items).toHaveLength(1);

      writer.close();
      reader.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
