# Plan 4: Twitter Migration to SitePlugin Format

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the existing Twitter site from hard-coded imports into a `SitePlugin` declaration, converting internal types to the framework's FeedItem/FeedResult format, and co-locating tests.

**Architecture:** Twitter keeps all its internal modules (extractors, matchers, types) but gains an `index.ts` entry point exporting a `SitePlugin` object. Workflows adapt to produce framework `FeedResult` instead of site-specific `FeedResult`. The store adapter changes signature from `Tweet[]` to `FeedItem[]`. Tests move to `__tests__/` directory.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** [M8 Multi-Site Plugin Architecture](./multi-site-plugin-architecture.md)

**Depends on:** Plan 1 (registry types)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/sites/twitter/feed-item.ts` | Tweet → FeedItem conversion + TwitterSiteMeta Zod schema |
| Modify | `src/sites/twitter/workflows.ts` | Return framework FeedResult (with FeedItem[]) instead of site-specific FeedResult |
| Modify | `src/sites/twitter/store-adapter.ts` | Change input from `Tweet[]` to `FeedItem[]`, extract from siteMeta |
| Modify | `src/sites/twitter/types.ts` | Keep Tweet as internal type; remove old FeedResult export (replaced by framework type) |
| Create | `src/sites/twitter/index.ts` | Export `plugin: SitePlugin` |
| Move | `tests/unit/twitter-*.test.ts` → `src/sites/twitter/__tests__/` | Co-locate tests, drop `twitter-` prefix |
| Create | `src/sites/twitter/__tests__/feed-item.test.ts` | FeedItem conversion + siteMeta validation tests |
| Modify | `src/sites/twitter/__tests__/store-adapter.test.ts` | Update for new FeedItem input |
| Modify | `src/sites/twitter/__tests__/workflows.test.ts` | Update for new FeedResult output |

---

### Task 1: TwitterSiteMeta schema and Tweet → FeedItem conversion

**Files:**
- Create: `src/sites/twitter/feed-item.ts`
- Create: `src/sites/twitter/__tests__/feed-item.test.ts`

This is the bridge between Twitter's internal `Tweet` type and the framework's `FeedItem`.

- [ ] **Step 1: Write failing tests**

```ts
// src/sites/twitter/__tests__/feed-item.test.ts
import { describe, it, expect } from 'vitest';
import { tweetToFeedItem, TwitterSiteMetaSchema } from '../feed-item.js';
import type { Tweet } from '../types.js';

const sampleTweet: Tweet = {
  id: '123',
  author: { handle: 'alice', name: 'Alice', following: true },
  text: 'Hello world',
  timestamp: '2026-03-26T12:00:00Z',
  url: 'https://x.com/alice/status/123',
  metrics: { likes: 10, retweets: 2, replies: 1, views: 100, bookmarks: 0, quotes: 0 },
  media: [{ type: 'photo', url: 'https://img.com/1.jpg', width: 800, height: 600 }],
  links: ['https://example.com'],
  isRetweet: false,
  isAd: false,
  surfaceReason: 'original' as const,
};

describe('tweetToFeedItem', () => {
  it('maps common fields correctly', () => {
    const item = tweetToFeedItem(sampleTweet);
    expect(item.id).toBe('123');
    expect(item.author).toEqual({ handle: 'alice', name: 'Alice' });
    expect(item.text).toBe('Hello world');
    expect(item.timestamp).toBe('2026-03-26T12:00:00Z');
    expect(item.url).toBe('https://x.com/alice/status/123');
    expect(item.media).toHaveLength(1);
    expect(item.links).toEqual(['https://example.com']);
  });

  it('puts Twitter-specific fields in siteMeta', () => {
    const item = tweetToFeedItem(sampleTweet);
    expect(item.siteMeta.likes).toBe(10);
    expect(item.siteMeta.retweets).toBe(2);
    expect(item.siteMeta.following).toBe(true);
    expect(item.siteMeta.surfaceReason).toBe('original');
    expect(item.siteMeta.isRetweet).toBe(false);
    expect(item.siteMeta.isAd).toBe(false);
  });

  it('includes optional fields when present', () => {
    const tweet: Tweet = {
      ...sampleTweet,
      surfacedBy: 'bob',
      quotedTweet: { ...sampleTweet, id: '456' },
      inReplyTo: { handle: 'carol', tweetId: '789' },
    };
    const item = tweetToFeedItem(tweet);
    expect(item.siteMeta.surfacedBy).toBe('bob');
    expect(item.siteMeta.quotedTweet).toBeDefined();
    expect(item.siteMeta.inReplyTo).toEqual({ handle: 'carol', tweetId: '789' });
  });

  it('validates siteMeta against TwitterSiteMetaSchema', () => {
    const item = tweetToFeedItem(sampleTweet);
    const result = TwitterSiteMetaSchema.safeParse(item.siteMeta);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/sites/twitter/__tests__/feed-item.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement feed-item conversion**

```ts
// src/sites/twitter/feed-item.ts
import { z } from 'zod';
import type { Tweet } from './types.js';
import type { FeedItem } from '../../registry/types.js';

/** Zod schema for Twitter-specific siteMeta — validates at construction time. */
export const TwitterSiteMetaSchema = z.object({
  likes: z.number().optional(),
  retweets: z.number().optional(),
  replies: z.number().optional(),
  views: z.number().optional(),
  bookmarks: z.number().optional(),
  quotes: z.number().optional(),
  following: z.boolean(),
  isRetweet: z.boolean(),
  isAd: z.boolean(),
  surfaceReason: z.enum(['original', 'retweet', 'quote', 'reply']),
  surfacedBy: z.string().optional(),
  quotedTweet: z.unknown().optional(),
  inReplyTo: z.object({ handle: z.string(), tweetId: z.string() }).optional(),
});

export type TwitterSiteMeta = z.infer<typeof TwitterSiteMetaSchema>;

/** Convert internal Tweet to framework FeedItem. */
export function tweetToFeedItem(tweet: Tweet): FeedItem {
  const siteMeta: TwitterSiteMeta = {
    likes: tweet.metrics.likes,
    retweets: tweet.metrics.retweets,
    replies: tweet.metrics.replies,
    views: tweet.metrics.views,
    bookmarks: tweet.metrics.bookmarks,
    quotes: tweet.metrics.quotes,
    following: tweet.author.following,
    isRetweet: tweet.isRetweet,
    isAd: tweet.isAd,
    surfaceReason: tweet.surfaceReason,
    surfacedBy: tweet.surfacedBy,
    quotedTweet: tweet.quotedTweet,
    inReplyTo: tweet.inReplyTo,
  };

  // Validate at construction time (design doc best practice)
  TwitterSiteMetaSchema.parse(siteMeta);

  return {
    id: tweet.id,
    author: { handle: tweet.author.handle, name: tweet.author.name },
    text: tweet.text,
    timestamp: tweet.timestamp,
    url: tweet.url,
    media: tweet.media,
    links: tweet.links,
    siteMeta,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/sites/twitter/__tests__/feed-item.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/feed-item.ts src/sites/twitter/__tests__/feed-item.test.ts
git commit -m "feat(twitter): Tweet to FeedItem conversion with siteMeta validation"
```

---

### Task 2: Adapt store-adapter to FeedItem input

**Files:**
- Modify: `src/sites/twitter/store-adapter.ts`
- Move + Modify: `tests/unit/twitter-store-adapter.test.ts` → `src/sites/twitter/__tests__/store-adapter.test.ts`

- [ ] **Step 1: Move the existing test file**

```bash
mkdir -p src/sites/twitter/__tests__
cp tests/unit/twitter-store-adapter.test.ts src/sites/twitter/__tests__/store-adapter.test.ts
```

- [ ] **Step 2: Update the test file for FeedItem input**

The test needs to construct `FeedItem` objects (with `siteMeta`) instead of `Tweet` objects. Update import paths and test data:

```ts
// src/sites/twitter/__tests__/store-adapter.test.ts
// Change imports:
//   from: import { tweetsToIngestItems } from '../../src/sites/twitter/store-adapter.js';
//   to:   import { feedItemsToIngestItems } from '../store-adapter.js';
// Change input data from Tweet to FeedItem (with siteMeta containing metrics)
// Keep all assertions about output IngestItem[] structure identical
```

Key changes in each test:
- Replace `tweet.metrics.likes` → `siteMeta.likes`
- Replace `tweet.author.following` → `siteMeta.following`
- Replace `tweet.surfaceReason` → `siteMeta.surfaceReason`
- Input is `FeedItem[]` instead of `Tweet[]`

- [ ] **Step 3: Run updated tests to verify they fail**

Run: `pnpm test src/sites/twitter/__tests__/store-adapter.test.ts`
Expected: FAIL — `feedItemsToIngestItems` does not exist

- [ ] **Step 4: Refactor store-adapter.ts**

Replace `tweetsToIngestItems` with `feedItemsToIngestItems`:

```ts
// src/sites/twitter/store-adapter.ts
import type { FeedItem } from '../../registry/types.js';
import type { IngestItem, MetricEntry, SearchResultItem } from '../../storage/types.js';
import type { TwitterSiteMeta } from './feed-item.js';

export function feedItemsToIngestItems(items: FeedItem[]): IngestItem[] {
  return items.map((item) => {
    const meta = item.siteMeta as TwitterSiteMeta;

    const mentions = extractMentions(item.text);
    if (meta.surfacedBy) mentions.push(meta.surfacedBy);
    if (meta.quotedTweet && typeof meta.quotedTweet === 'object' && 'author' in (meta.quotedTweet as Record<string, unknown>)) {
      const qt = meta.quotedTweet as { author: { handle: string } };
      mentions.push(qt.author.handle);
    }
    if (meta.inReplyTo?.handle) mentions.push(meta.inReplyTo.handle);
    const uniqueMentions = [...new Set(mentions)];

    const metrics = extractMetrics(meta);
    metrics.push({ metric: 'surface_reason', strValue: meta.surfaceReason });
    metrics.push({ metric: 'following', numValue: meta.following ? 1 : 0 });

    return {
      site: 'twitter', // Will be overwritten by framework, but harmless to set
      id: item.id,
      text: item.text,
      author: item.author.handle,
      timestamp: item.timestamp,
      url: item.url,
      rawJson: JSON.stringify(item),
      mentions: uniqueMentions,
      hashtags: extractHashtags(item.text),
      metrics,
    };
  });
}

// Keep tweetToSearchResultItem for backward compat — used by cli/workflow.ts
// until Plan 5 replaces CLI with codegen dispatcher. Then delete.
export function tweetToSearchResultItem(tweet: Tweet): SearchResultItem {
  // ... existing implementation unchanged (copy from current store-adapter.ts) ...
}

function extractMetrics(meta: TwitterSiteMeta): MetricEntry[] {
  const entries: Array<{ metric: string; value: number | undefined }> = [
    { metric: 'likes', value: meta.likes },
    { metric: 'retweets', value: meta.retweets },
    { metric: 'replies', value: meta.replies },
    { metric: 'views', value: meta.views },
    { metric: 'bookmarks', value: meta.bookmarks },
    { metric: 'quotes', value: meta.quotes },
  ];
  return entries
    .filter((e): e is { metric: string; value: number } => e.value != null)
    .map((e) => ({ metric: e.metric, numValue: e.value }));
}

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/@(\w+)/g);
  return [...matches].map((m) => m[1]);
}

function extractHashtags(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1].toLowerCase());
}
```

> **Note on `tweetToSearchResultItem`:** This function is used by `cli/workflow.ts` (lines 104, 202) to convert Tweet → SearchResultItem for CLI display. After M8, `cli/workflow.ts` is replaced by the codegen CLI dispatcher (Plan 5), which outputs FeedResult JSON directly — no SearchResultItem conversion needed. So `tweetToSearchResultItem` becomes dead code after Plan 5. During the transition (Plan 4 → Plan 5), keep it in `store-adapter.ts` alongside `feedItemsToIngestItems`. Plan 5 Task 5 will delete it when cleaning up.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/sites/twitter/__tests__/store-adapter.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/store-adapter.ts src/sites/twitter/__tests__/store-adapter.test.ts
git commit -m "refactor(twitter): store adapter accepts FeedItem[] instead of Tweet[]"
```

---

### Task 3: Adapt workflows to return framework FeedResult

**Files:**
- Modify: `src/sites/twitter/workflows.ts`
- Modify: `src/sites/twitter/types.ts`

- [ ] **Step 1: Add FeedParams Zod schema to types.ts**

Add at the end of `src/sites/twitter/types.ts`:

```ts
import { z } from 'zod';

// ... existing code ...

/** Twitter-specific feed parameters (used for MCP tool inputSchema). */
export const TwitterFeedParamsSchema = z.object({
  count: z.number().min(1).max(100).default(20)
    .describe('Number of tweets to collect'),
  tab: z.enum(['following', 'for_you']).default('following')
    .describe('Which feed tab to read: "following" (chronological) or "for_you" (algorithmic)'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info (tab action, reload fallback, GraphQL counts, timing)'),
  dump_raw: z.string().optional()
    .describe('Directory path to dump raw GraphQL responses for debugging'),
});
```

- [ ] **Step 2: Update getFeed to return framework FeedResult**

In `src/sites/twitter/workflows.ts`:

1. Add import: `import { tweetToFeedItem } from './feed-item.js';`
2. Add import: `import type { FeedResult as FrameworkFeedResult } from '../../registry/types.js';`
3. Rename old `FeedResult` import to `TwitterFeedResult` (or remove it)
4. At the end of `getFeed`, convert tweets to FeedItems:

```ts
// Before returning, convert Tweet[] → FeedItem[]
const items = tweets.map(tweetToFeedItem);

const result: FrameworkFeedResult = {
  items,
  meta: {
    coveredUsers: meta.coveredUsers,
    timeRange: { from: meta.oldestTimestamp, to: meta.newestTimestamp },
  },
};

return result;
```

5. Change the return type of `getFeed` to `Promise<FrameworkFeedResult>`
6. Remove the `store` parameter from `GetFeedOptions` — framework handles ingest now
7. Remove manual `store.ingest()` call inside `getFeed`

- [ ] **Step 3: Run existing workflow tests to check what breaks**

Run: `pnpm test tests/unit/twitter-workflows.test.ts`
Expected: some tests may fail due to return type changes (`tweets` → `items`, `meta` shape change)

- [ ] **Step 4: Move and update workflow tests**

```bash
cp tests/unit/twitter-workflows.test.ts src/sites/twitter/__tests__/workflows.test.ts
```

Update assertions in the test file:
- `result.tweets` → `result.items`
- `result.meta.oldestTimestamp` → `result.meta.timeRange.from`
- `result.meta.newestTimestamp` → `result.meta.timeRange.to`
- Each item is now a `FeedItem` (with `siteMeta`) not a `Tweet`
- Remove tests about `store.ingest()` being called (framework handles this now)

- [ ] **Step 5: Run updated tests**

Run: `pnpm test src/sites/twitter/__tests__/workflows.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/workflows.ts src/sites/twitter/types.ts src/sites/twitter/__tests__/workflows.test.ts
git commit -m "refactor(twitter): workflows return framework FeedResult with FeedItem[]"
```

---

### Task 4: Create SitePlugin export and move remaining tests

**Files:**
- Create: `src/sites/twitter/index.ts`
- Move remaining tests to `src/sites/twitter/__tests__/`

- [ ] **Step 1: Create `src/sites/twitter/index.ts`**

```ts
// src/sites/twitter/index.ts
import type { SitePlugin } from '../../registry/types.js';
import { twitterDetect } from './site.js';
import { checkLogin } from './workflows.js';
import { getFeed } from './workflows.js';
import { feedItemsToIngestItems } from './store-adapter.js';
import { TwitterFeedParamsSchema } from './types.js';

export const plugin: SitePlugin = {
  apiVersion: 1,
  name: 'twitter',
  domains: ['x.com', 'twitter.com'],
  detect: twitterDetect,

  capabilities: {
    auth: {
      check: checkLogin,
      description: 'Check if user is logged in to Twitter/X. Returns { loggedIn: boolean }.',
    },
    feed: {
      collect: getFeed,
      params: TwitterFeedParamsSchema,
      description:
        'Collect tweets from Twitter/X timeline. Supports "following" (chronological) ' +
        'and "for_you" (algorithmic) tabs. Returns structured tweet data with metrics, ' +
        'media, and thread context.',
    },
  },

  storeAdapter: {
    toIngestItems: feedItemsToIngestItems,
  },

  hints: {
    sessionExpired:
      'User is not logged in to Twitter/X. Ask the user to open the browser, ' +
      'navigate to x.com, and log in manually. Then retry.',
    rateLimited:
      'Rate limited by Twitter/X. Wait at least 15 minutes before retrying. ' +
      'Do not attempt to scroll or navigate on Twitter during this time.',
    elementNotFound:
      'Expected UI element not found on Twitter/X. The page may not have loaded, ' +
      'or Twitter may have updated their UI. Try taking a screenshot to diagnose.',
  },
};
```

- [ ] **Step 2: Regenerate the built-in registry**

Run: `node scripts/generate-registry.mjs`
Expected: prints `Generated ... with 1 plugin(s): twitter`

Verify `src/sites/_registry.ts` now contains:
```ts
export { plugin as twitter } from './twitter/index.js';
```

- [ ] **Step 3: Move remaining test files**

```bash
cp tests/unit/twitter-extractors.test.ts src/sites/twitter/__tests__/extractors.test.ts
cp tests/unit/twitter-types.test.ts src/sites/twitter/__tests__/types.test.ts
cp tests/unit/twitter-format.test.ts src/sites/twitter/__tests__/format.test.ts
cp tests/unit/twitter-matchers.test.ts src/sites/twitter/__tests__/matchers.test.ts
```

Update import paths in each file: `../../src/sites/twitter/` → `../`

- [ ] **Step 4: Run all co-located tests**

Run: `pnpm test src/sites/twitter/__tests__`
Expected: all tests PASS

- [ ] **Step 5: Delete old test files**

```bash
rm tests/unit/twitter-extractors.test.ts
rm tests/unit/twitter-workflows.test.ts
rm tests/unit/twitter-store-adapter.test.ts
rm tests/unit/twitter-types.test.ts
rm tests/unit/twitter-format.test.ts
rm tests/unit/twitter-matchers.test.ts
```

- [ ] **Step 6: Run full test suite to verify nothing is lost**

Run: `pnpm test`
Expected: same total test count as before migration, all PASS

- [ ] **Step 7: Build and verify**

Run: `pnpm run build`
Expected: success

- [ ] **Step 8: Commit**

```bash
git add src/sites/twitter/index.ts src/sites/_registry.ts src/sites/twitter/__tests__/
git add -u tests/unit/  # stage deletions
git commit -m "feat(twitter): export SitePlugin, co-locate tests, regenerate registry"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] Twitter exports `SitePlugin` from `index.ts` (Section 2.4) → Task 4
   - [x] FeedItem with siteMeta for Twitter-specific fields (Section 1.1) → Task 1
   - [x] siteMeta Zod validation at construction time (Best Practice in Section 1.1) → Task 1
   - [x] StoreAdapter.toIngestItems receives `FeedItem[]` (Section 1.4) → Task 2
   - [x] getFeed returns framework FeedResult (Section 1.1) → Task 3
   - [x] Feed params as Zod schema (Section 1.1, FeedCapability) → Task 3
   - [x] Error hints declared on plugin (Section 1.5) → Task 4
   - [x] Tests co-located in `__tests__/` (Section 7.1) → Task 4
   - [x] Built-in registry regenerated (Section 10.1) → Task 4
   - [x] Store ingest removed from workflow (Section 6.1 — framework handles) → Task 3
   - [x] Backward compat: tool names unchanged (Section 0) → Task 4 (same name in plugin)

2. **Placeholder scan:** Task 2 Step 2 and Task 3 Step 4 describe test changes at high level rather than showing full rewritten test files. This is intentional — the test modifications are mechanical (rename fields, update paths) and showing 400+ lines of test code would obscure the actual changes. The engineer should diff the old vs new patterns.

3. **Type consistency:** `tweetToFeedItem`, `TwitterSiteMetaSchema`, `TwitterSiteMeta`, `feedItemsToIngestItems`, `TwitterFeedParamsSchema` — all consistent across tasks.
