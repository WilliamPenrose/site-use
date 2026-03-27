/**
 * Comprehensive tests for --local mode behavior.
 *
 * Covers:
 * - Storage layer: search ordering, count limits, metric filters, field filters
 * - Local query output: text and JSON formats
 * - Smart default decision: fresh → local, stale → fetch, no_data → fetch
 * - Known limitation: --tab following vs for_you return identical data in local mode
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../../src/storage/index.js';
import { feedItemsToIngestItems } from '../../src/sites/twitter/store-adapter.js';
import type { FeedItem } from '../../src/registry/types.js';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeFeedItem(overrides: Partial<FeedItem> & { id: string }): FeedItem {
  return {
    author: { handle: 'alice', name: 'Alice' },
    text: `Tweet ${overrides.id}`,
    timestamp: '2026-03-25T12:00:00Z',
    url: `https://x.com/alice/${overrides.id}`,
    media: [],
    links: [],
    siteMeta: {
      likes: 10, retweets: 2, replies: 1, views: 100,
      following: true, isRetweet: false, isAd: false,
      surfaceReason: 'original',
    },
    ...overrides,
  };
}

// A set of tweets that simulates a mix of following-tab and for_you-tab content.
// In practice the DB cannot distinguish which tab they came from.
const FOLLOWING_ITEMS = [
  makeFeedItem({ id: 'f1', author: { handle: 'alice', name: 'Alice' }, text: 'Following tweet 1', timestamp: '2026-03-25T14:00:00Z', siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, following: true, surfaceReason: 'original' } }),
  makeFeedItem({ id: 'f2', author: { handle: 'bob', name: 'Bob' }, text: 'Following tweet 2', timestamp: '2026-03-25T13:00:00Z', siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, following: true, surfaceReason: 'original' } }),
  makeFeedItem({ id: 'f3', author: { handle: 'carol', name: 'Carol' }, text: 'Following tweet 3 with #news', timestamp: '2026-03-25T12:00:00Z', siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, following: true, surfaceReason: 'original' } }),
];

const FOR_YOU_ITEMS = [
  makeFeedItem({ id: 'fy1', author: { handle: 'dave', name: 'Dave' }, text: 'For you tweet 1 by @alice', timestamp: '2026-03-25T14:30:00Z', siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, following: false, surfaceReason: 'original' } }),
  makeFeedItem({ id: 'fy2', author: { handle: 'eve', name: 'Eve' }, text: 'For you tweet 2', timestamp: '2026-03-25T13:30:00Z', siteMeta: { likes: 10, retweets: 2, replies: 1, views: 100, following: false, surfaceReason: 'retweet', surfacedBy: 'frank' } }),
  makeFeedItem({ id: 'fy3', author: { handle: 'grace', name: 'Grace' }, text: 'For you tweet 3', timestamp: '2026-03-25T11:00:00Z', siteMeta: { likes: 5000, retweets: 800, replies: 200, views: 100000, following: false, surfaceReason: 'original' } }),
];

const ALL_ITEMS = [...FOLLOWING_ITEMS, ...FOR_YOU_ITEMS];

// ---------------------------------------------------------------------------
// Storage layer — search behavior in local mode
// ---------------------------------------------------------------------------

describe('local mode: storage layer', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mode-'));
    dbPath = path.join(tmpDir, 'knowledge.db');
    const store = createStore(dbPath);
    await store.ingest(feedItemsToIngestItems(ALL_ITEMS));
    store.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns items ordered by timestamp DESC', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 100 });
      const timestamps = result.items.map((i) => i.timestamp);
      const sorted = [...timestamps].sort().reverse();
      expect(timestamps).toEqual(sorted);
    } finally {
      store.close();
    }
  });

  it('respects max_results limit', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 3 });
      expect(result.items).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it('defaults max_results to 20 when omitted', async () => {
    const store = createStore(dbPath);
    try {
      // We only have 6 items, so all should be returned
      const result = await store.search({ site: 'twitter' });
      expect(result.items).toHaveLength(6);
    } finally {
      store.close();
    }
  });

  it('filters by author', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', author: 'alice' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].author).toBe('alice');
    } finally {
      store.close();
    }
  });

  it('filters by date range', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({
        site: 'twitter',
        start_date: '2026-03-25T13:00:00Z',
        end_date: '2026-03-25T14:00:01Z',
      });
      // f1 (14:00), f2 (13:00), fy2 (13:30)
      expect(result.items).toHaveLength(3);
      for (const item of result.items) {
        expect(item.timestamp! >= '2026-03-25T13:00:00Z').toBe(true);
        expect(item.timestamp! < '2026-03-25T14:00:01Z').toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it('filters by hashtag', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', hashtag: '#news' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('f3');
    } finally {
      store.close();
    }
  });

  it('filters by mention', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', mention: 'alice' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('fy1');
    } finally {
      store.close();
    }
  });

  it('filters by metric (following=1)', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({
        site: 'twitter',
        metricFilters: [{ metric: 'following', op: '=', numValue: 1 }],
      });
      expect(result.items).toHaveLength(3);
      for (const item of result.items) {
        expect(item.siteMeta?.following).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it('filters by metric (following=0 — not-following authors)', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({
        site: 'twitter',
        metricFilters: [{ metric: 'following', op: '=', numValue: 0 }],
      });
      expect(result.items).toHaveLength(3);
      for (const item of result.items) {
        expect(item.siteMeta?.following).toBe(false);
      }
    } finally {
      store.close();
    }
  });

  it('filters by metric (likes >= threshold)', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({
        site: 'twitter',
        metricFilters: [{ metric: 'likes', op: '>=', numValue: 1000 }],
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('fy3');
    } finally {
      store.close();
    }
  });

  it('resolves siteMeta from rawJson (likes, retweets, surfaceReason)', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 100 });
      const fy2 = result.items.find((i) => i.id === 'fy2')!;
      expect(fy2.siteMeta).toBeDefined();
      expect(fy2.siteMeta!.likes).toBe(10);
      expect(fy2.siteMeta!.retweets).toBe(2);
      expect(fy2.siteMeta!.surfaceReason).toBe('retweet');
      expect(fy2.siteMeta!.surfacedBy).toBe('frank');
    } finally {
      store.close();
    }
  });

  it('resolves mentions from item_mentions table', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 100 });
      const fy1 = result.items.find((i) => i.id === 'fy1')!;
      expect(fy1.mentions).toContain('alice');
    } finally {
      store.close();
    }
  });

  it('applies fields filter to limit returned data', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 1, fields: ['author', 'url'] });
      const item = result.items[0];
      expect(item.author).toBeDefined();
      expect(item.url).toBeDefined();
      expect(item.text).toBeUndefined();
      expect(item.timestamp).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('countItems counts all twitter items (no tab filter)', async () => {
    const store = createStore(dbPath);
    try {
      const count = await store.countItems({ site: 'twitter' });
      expect(count).toBe(6);
    } finally {
      store.close();
    }
  });

  it('countItems with following metric filter counts only followed authors', async () => {
    const store = createStore(dbPath);
    try {
      const count = await store.countItems({
        site: 'twitter',
        metricFilters: [{ metric: 'following', op: '=', numValue: 1 }],
      });
      expect(count).toBe(3);
    } finally {
      store.close();
    }
  });

  it('returns empty result for non-existent site', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'nonexistent' });
      expect(result.items).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('handles duplicate ingest gracefully (upsert)', async () => {
    const store = createStore(dbPath);
    try {
      // Re-ingest same items
      const ingestResult = await store.ingest(feedItemsToIngestItems(FOLLOWING_ITEMS));
      expect(ingestResult.duplicates).toBe(3);
      expect(ingestResult.inserted).toBe(0);
      // Count remains the same
      const count = await store.countItems({ site: 'twitter' });
      expect(count).toBe(6);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tab indistinguishable behavior in local mode (known limitation)
// ---------------------------------------------------------------------------

describe('local mode: tab indistinguishable (known limitation)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tab-'));
    dbPath = path.join(tmpDir, 'knowledge.db');
    const store = createStore(dbPath);
    await store.ingest(feedItemsToIngestItems(ALL_ITEMS));
    store.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('search with no metric filter returns both following and for_you tweets', async () => {
    const store = createStore(dbPath);
    try {
      const result = await store.search({ site: 'twitter', max_results: 100 });
      const ids = result.items.map((i) => i.id);
      // Contains tweets from both "tabs"
      expect(ids).toContain('f1');
      expect(ids).toContain('fy1');
      expect(result.items).toHaveLength(6);
    } finally {
      store.close();
    }
  });

  it('--tab following filters by following=1 metric, --tab for_you returns all', async () => {
    // runLocalQuery adds metricFilters: [{following=1}] for --tab following,
    // and no filter for --tab for_you.
    const store = createStore(dbPath);
    try {
      // Simulate --tab following: only followed authors
      const followingResult = await store.search({
        site: 'twitter',
        max_results: 20,
        metricFilters: [{ metric: 'following', op: '=', numValue: 1 }],
      });
      expect(followingResult.items).toHaveLength(3);
      for (const item of followingResult.items) {
        expect(item.siteMeta?.following).toBe(true);
      }

      // Simulate --tab for_you: no filter, returns everything
      const forYouResult = await store.search({ site: 'twitter', max_results: 20 });
      expect(forYouResult.items).toHaveLength(6);
    } finally {
      store.close();
    }
  });

  it('following metric approximates Following tab (authors you follow)', async () => {
    // The "following" metric = author.following (does user follow this author).
    // This is a reasonable proxy for "Following tab" content because that tab
    // only shows tweets from authors you follow.
    // Note: For You tab may also surface followed authors, so for_you returns all data.
    const store = createStore(dbPath);
    try {
      const followedResult = await store.search({
        site: 'twitter',
        metricFilters: [{ metric: 'following', op: '=', numValue: 1 }],
      });
      const followedIds = followedResult.items.map((i) => i.id);
      expect(followedIds).toContain('f1');
      expect(followedIds).toContain('f2');
      expect(followedIds).toContain('f3');
      expect(followedIds).not.toContain('fy1');
      expect(followedIds).not.toContain('fy2');
    } finally {
      store.close();
    }
  });

  it('countItems without metric filters counts all tweets regardless of tab', async () => {
    const store = createStore(dbPath);
    try {
      // This is what the smart default uses to decide "do we have cached data?"
      const count = await store.countItems({ site: 'twitter' });
      expect(count).toBe(6); // all tweets, both "tabs"
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Smart default decision logic
// ---------------------------------------------------------------------------

describe('local mode: smart default freshness-based decision', () => {
  let tmpDir: string;
  let dbPath: string;
  let tsFilePath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-default-'));
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    dbPath = path.join(tmpDir, 'data', 'knowledge.db');
    tsFilePath = path.join(tmpDir, 'fetch-timestamps.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // We test the building blocks that runTwitterFeed uses, since runTwitterFeed
  // itself is not exported and requires browser infrastructure.

  it('checkFreshness uses tab as variant key — different tabs have independent freshness', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(tsFilePath, JSON.stringify({
      twitter: { following: recentTs },
    }));

    const followingCheck = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(followingCheck.reason).toBe('fresh');

    const forYouCheck = checkFreshness(tmpDir, 'twitter', 'for_you', 120);
    expect(forYouCheck.reason).toBe('no_data');
  });

  it('fresh following + stale for_you: smart default chooses differently per tab', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const oldTs = new Date(Date.now() - 180 * 60_000).toISOString();

    fs.writeFileSync(tsFilePath, JSON.stringify({
      twitter: { following: recentTs, for_you: oldTs },
    }));

    expect(checkFreshness(tmpDir, 'twitter', 'following', 120).shouldFetch).toBe(false);
    expect(checkFreshness(tmpDir, 'twitter', 'for_you', 120).shouldFetch).toBe(true);
  });

  it('fresh data + populated DB → smart default uses local (simulated)', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    // Set up fresh timestamps
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(tsFilePath, JSON.stringify({ twitter: { following: recentTs } }));

    // Populate DB
    const store = createStore(dbPath);
    await store.ingest(feedItemsToIngestItems(FOLLOWING_ITEMS));

    const freshness = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(freshness.reason).toBe('fresh');

    const count = await store.countItems({ site: 'twitter' });
    expect(count).toBeGreaterThan(0);
    store.close();

    // In runTwitterFeed, this combination means useLocal = true
  });

  it('fresh data + empty DB → smart default would trigger fetch', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(tsFilePath, JSON.stringify({ twitter: { following: recentTs } }));

    // Create DB but don't ingest anything
    const store = createStore(dbPath);
    const freshness = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(freshness.reason).toBe('fresh');

    const count = await store.countItems({ site: 'twitter' });
    expect(count).toBe(0);
    store.close();

    // In runTwitterFeed, count === 0 means useLocal = false
  });

  it('fresh data + missing DB file → smart default would trigger fetch', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(tsFilePath, JSON.stringify({ twitter: { following: recentTs } }));

    const freshness = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(freshness.reason).toBe('fresh');
    expect(fs.existsSync(dbPath)).toBe(false);

    // In runTwitterFeed, !fs.existsSync(dbPath) means useLocal = false
  });

  it('--max-age 0 always makes data stale (forces fetch)', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const justNow = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(tsFilePath, JSON.stringify({ twitter: { following: justNow } }));

    const result = checkFreshness(tmpDir, 'twitter', 'following', 0);
    expect(result.shouldFetch).toBe(true);
    expect(result.reason).toBe('stale');
  });

  it('--max-age large value keeps data fresh for longer', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const hoursAgo = new Date(Date.now() - 300 * 60_000).toISOString(); // 5 hours
    fs.writeFileSync(tsFilePath, JSON.stringify({ twitter: { following: hoursAgo } }));

    // Default 120min → stale
    expect(checkFreshness(tmpDir, 'twitter', 'following', 120).reason).toBe('stale');
    // 600min → still fresh
    expect(checkFreshness(tmpDir, 'twitter', 'following', 600).reason).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// CLI integration: --local with pre-populated database
// ---------------------------------------------------------------------------

describe('local mode: CLI integration', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cli-'));
    // DB lives at {dataDir}/knowledge.db (same as codegen path in getConfig)
    dbPath = path.join(tmpDir, 'knowledge.db');
    const store = createStore(dbPath);
    await store.ingest(feedItemsToIngestItems(ALL_ITEMS));
    store.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const bin = path.resolve('dist/index.js');
  const run = (args: string[]) => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    return execFileSync('node', [bin, 'twitter', 'feed', ...args], {
      env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
      encoding: 'utf-8',
      timeout: 15_000,
    });
  };

  const runWithStderr = (args: string[]) => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const proc = spawnSync('node', [bin, 'twitter', 'feed', ...args], {
      env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return { stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', status: proc.status ?? 0 };
  };

  it('--local returns cached tweets as JSON FeedResult', () => {
    const output = run(['--local']);
    // Default tab is "for_you" → all tweets (no filter)
    // Output is a FeedResult object, always JSON
    const result = JSON.parse(output);
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('meta');
    const texts = result.items.map((i: { text: string }) => i.text);
    expect(texts.some((t: string) => t.includes('Following tweet 1'))).toBe(true);
    expect(texts.some((t: string) => t.includes('For you tweet 1'))).toBe(true);
  });

  it('--local outputs valid FeedResult with items array', () => {
    const output = run(['--local', '--tab', 'for_you']);
    const result = JSON.parse(output);
    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(6);
    // Each item has expected FeedItem fields
    for (const item of result.items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('text');
      expect(item).toHaveProperty('author');
    }
  });

  it('--local --count 2 limits output to 2 items', () => {
    const output = run(['--local', '--count', '2', '--tab', 'for_you']);
    const result = JSON.parse(output);
    expect(result.items).toHaveLength(2);
  });

  it('--local --count 2 returns the 2 most recent tweets', () => {
    const output = run(['--local', '--count', '2', '--tab', 'for_you']);
    const result = JSON.parse(output);
    // Most recent: fy1 (14:30), f1 (14:00)
    const ids = result.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(['fy1', 'f1']);
  });

  it('--local items include siteMeta with metrics', () => {
    const output = run(['--local', '--count', '1', '--tab', 'for_you']);
    const result = JSON.parse(output);
    const item = result.items[0];
    expect(item.siteMeta).toBeDefined();
    expect(typeof item.siteMeta.likes).toBe('number');
    expect(typeof item.siteMeta.retweets).toBe('number');
  });

  it('--local --tab following returns only followed authors', () => {
    const output = run(['--local', '--tab', 'following']);
    const result = JSON.parse(output);
    // Only the 3 tweets from followed authors (alice, bob, carol)
    expect(result.items).toHaveLength(3);
    const authors = result.items.map((i: { author: { handle: string } }) => i.author.handle);
    expect(authors).toContain('alice');
    expect(authors).toContain('bob');
    expect(authors).toContain('carol');
    expect(authors).not.toContain('dave');
    expect(authors).not.toContain('eve');
  });

  it('--local --tab for_you returns all tweets', () => {
    const output = run(['--local', '--tab', 'for_you']);
    const result = JSON.parse(output);
    expect(result.items).toHaveLength(6);
  });

  it('--local default tab (for_you) returns all tweets', () => {
    // Default tab is "for_you", so --local without --tab returns all tweets
    const output = run(['--local']);
    const result = JSON.parse(output);
    expect(result.items).toHaveLength(6);
  });

  it('--local shows hint message on stderr', () => {
    const { stderr } = runWithStderr(['--local']);
    // codegen path outputs "Using cached data (Xmin old)." for local queries
    expect(stderr).toContain('cached');
  });

  it('--local with empty DB shows no local data error', async () => {
    // Create a fresh empty DB — hasLocalData returns false → throws "No local data found"
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-empty-'));
    const emptyDbPath = path.join(emptyDir, 'knowledge.db');
    const store = createStore(emptyDbPath);
    store.close();

    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync('node', [bin, 'twitter', 'feed', '--local'], {
        env: { ...process.env, SITE_USE_DATA_DIR: emptyDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected exit code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain('No local data found');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('--local with missing DB shows no local data error', () => {
    const noDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-nodb-'));
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync('node', [bin, 'twitter', 'feed', '--local'], {
        env: { ...process.env, SITE_USE_DATA_DIR: noDbDir },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect.unreachable('Expected exit code 1');
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain('No local data found');
    } finally {
      fs.rmSync(noDbDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Smart default decision logic (pure unit tests — no CLI, no browser)
// ---------------------------------------------------------------------------

describe('smart default: checkFreshness decision logic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns fresh when timestamp is within maxAge', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(tmpDir, 'fetch-timestamps.json'),
      JSON.stringify({ twitter: { for_you: recentTs } }),
    );

    const result = checkFreshness(tmpDir, 'twitter', 'for_you', 120);
    expect(result.shouldFetch).toBe(false);
    expect(result.reason).toBe('fresh');
    expect(result.ageMinutes).toBeLessThanOrEqual(11);
  });

  it('returns stale when timestamp exceeds maxAge', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const oldTs = new Date(Date.now() - 150 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(tmpDir, 'fetch-timestamps.json'),
      JSON.stringify({ twitter: { for_you: oldTs } }),
    );

    const result = checkFreshness(tmpDir, 'twitter', 'for_you', 120);
    expect(result.shouldFetch).toBe(true);
    expect(result.reason).toBe('stale');
  });

  it('returns no_data when no timestamp exists for the requested tab', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const recentTs = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(tmpDir, 'fetch-timestamps.json'),
      JSON.stringify({ twitter: { following: recentTs } }),
    );

    // "following" is fresh
    const followingCheck = checkFreshness(tmpDir, 'twitter', 'following', 120);
    expect(followingCheck.shouldFetch).toBe(false);

    // "for_you" has no timestamp → would trigger fetch
    const forYouCheck = checkFreshness(tmpDir, 'twitter', 'for_you', 120);
    expect(forYouCheck.shouldFetch).toBe(true);
    expect(forYouCheck.reason).toBe('no_data');
  });

  it('returns no_data when timestamp file does not exist', async () => {
    const { checkFreshness } = await import('../../src/cli/freshness.js');
    const result = checkFreshness(tmpDir, 'twitter', 'for_you', 120);
    expect(result.shouldFetch).toBe(true);
    expect(result.reason).toBe('no_data');
  });
});

// ---------------------------------------------------------------------------
// Smart default CLI integration (--local only, never launches browser)
// ---------------------------------------------------------------------------

describe('local mode: smart default CLI integration', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-cli-'));
    // DB lives at {dataDir}/knowledge.db (same as codegen path in getConfig)
    dbPath = path.join(tmpDir, 'knowledge.db');
    const store = createStore(dbPath);
    await store.ingest(feedItemsToIngestItems(ALL_ITEMS));
    store.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const bin = path.resolve('dist/index.js');

  it('--local returns all tweets for default tab (for_you) as FeedResult', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const output = execFileSync('node', [bin, 'twitter', 'feed', '--local'], {
      env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
      encoding: 'utf-8',
      timeout: 15_000,
    });

    const result = JSON.parse(output);
    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(6);
  });

  it('--local stderr shows cached data hint', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const proc = spawnSync('node', [bin, 'twitter', 'feed', '--local'], {
      env: { ...process.env, SITE_USE_DATA_DIR: tmpDir },
      encoding: 'utf-8',
      timeout: 15_000,
    });

    expect(proc.stderr).toContain('cached');
  });
});
