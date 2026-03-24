import { describe, it, expect, afterEach } from 'vitest';
import { createStore } from '../../src/storage/index.js';
import type { KnowledgeStore } from '../../src/storage/types.js';
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
      rawJson: '{"test": true}',
      mentions: ['someone'],
      hashtags: ['ai'],
      links: ['https://example.com/post'],
      siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, bookmarks: 0, quotes: 0, isRetweet: false, isAd: false },
    }]);
    expect(ingestResult.inserted).toBe(1);

    const searchResult = await store.search({ query: 'AI agents' });
    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0].author).toBe('testbot');

    const authorResult = await store.search({ author: 'testbot' });
    expect(authorResult.items).toHaveLength(1);

    const hashResult = await store.search({ hashtag: 'ai' });
    expect(hashResult.items).toHaveLength(1);

    const linkResult = await store.search({ link: 'example.com' });
    expect(linkResult.items).toHaveLength(1);
    expect(linkResult.items[0].links).toEqual(['https://example.com/post']);

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
      rawJson: '{}', mentions: [], hashtags: [],
    };

    await store.ingest([item]);
    const result = await store.ingest([item]);
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1);

    const s = await store.stats();
    expect(s.totalItems).toBe(1);
  });

  it('concurrent read/write via WAL mode (file-based db)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    // Reset module-level store so afterEach does not double-close a previous instance.
    store = undefined as unknown as KnowledgeStore;

    try {
      const writer = createStore(dbPath);
      const reader = createStore(dbPath);

      await writer.ingest([{
        site: 'twitter', id: 'wal1', text: 'WAL concurrency test', author: 'tester',
        timestamp: '2026-03-20T10:00:00Z', url: 'https://x.com/tester/status/wal1',
        rawJson: '{}', mentions: [], hashtags: [],
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
