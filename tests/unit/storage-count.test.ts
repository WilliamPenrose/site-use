import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../../src/storage/index.js';

describe('KnowledgeStore.countItems', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-count-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 for empty store', async () => {
    const store = createStore(dbPath);
    try {
      const count = await store.countItems({ site: 'twitter' });
      expect(count).toBe(0);
    } finally {
      store.close();
    }
  });

  it('returns count filtered by site', async () => {
    const store = createStore(dbPath);
    try {
      await store.ingest([
        { site: 'twitter', id: '1', text: 'hello', author: 'a', timestamp: '2026-03-25T00:00:00Z', url: 'https://x.com/a/1', rawJson: '{}' },
        { site: 'twitter', id: '2', text: 'world', author: 'b', timestamp: '2026-03-25T01:00:00Z', url: 'https://x.com/b/2', rawJson: '{}' },
        { site: 'other', id: '3', text: 'nope', author: 'c', timestamp: '2026-03-25T02:00:00Z', url: 'https://other.com/3', rawJson: '{}' },
      ]);
      const count = await store.countItems({ site: 'twitter' });
      expect(count).toBe(2);
    } finally {
      store.close();
    }
  });

  it('returns count filtered by metric', async () => {
    const store = createStore(dbPath);
    try {
      await store.ingest([
        { site: 'twitter', id: '1', text: 'a', author: 'a', timestamp: '2026-03-25T00:00:00Z', url: 'u1', rawJson: '{}', metrics: [{ metric: 'following', numValue: 1 }] },
        { site: 'twitter', id: '2', text: 'b', author: 'b', timestamp: '2026-03-25T01:00:00Z', url: 'u2', rawJson: '{}', metrics: [{ metric: 'following', numValue: 0 }] },
      ]);
      const count = await store.countItems({ site: 'twitter', metricFilters: [{ metric: 'following', op: '=', numValue: 1 }] });
      expect(count).toBe(1);
    } finally {
      store.close();
    }
  });
});
