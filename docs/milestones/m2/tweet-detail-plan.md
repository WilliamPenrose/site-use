# tweet_detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `twitter_tweet_detail` MCP tool — given a tweet URL, return the original tweet (full text) and its replies as a standard `FeedResult`.

**Architecture:** GraphQL interception pattern (same as `getFeed`). Navigate to tweet detail page, intercept `/TweetDetail` GraphQL responses, extract anchor tweet + replies via `extractFromTweetResult`, scroll for more if needed. Registered as `customWorkflows[]`.

**Tech Stack:** TypeScript, Zod, Vitest, puppeteer-core (via Primitives abstraction)

**Spec:** [tweet-detail-design.md](./tweet-detail-design.md)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sites/twitter/types.ts` | Modify | Add `TweetDetailParamsSchema`, `TweetDetailParsed` interface |
| `src/sites/twitter/extractors.ts` | Modify | Add `parseTweetDetail()`, export `GRAPHQL_TWEET_DETAIL_PATTERN` |
| `src/sites/twitter/workflows.ts` | Modify | Add `ensureTweetDetail()`, `getTweetDetail()` |
| `src/sites/twitter/index.ts` | Modify | Register `customWorkflows[]` |
| `src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json` | Create | First-page GraphQL fixture |
| `src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json` | Create | Scroll-loaded GraphQL fixture |
| `src/sites/twitter/__tests__/types.test.ts` | Modify | Add `TweetDetailParamsSchema` validation tests |
| `src/sites/twitter/__tests__/extractors.test.ts` | Modify | Add `parseTweetDetail` tests |
| `src/sites/twitter/__tests__/workflows.test.ts` | Modify | Add `ensureTweetDetail`, `getTweetDetail` tests |

---

### Task 1: Prepare test fixtures

Extract fixture data from the captured GraphQL responses. Two fixtures: initial load (has anchor + replies + cursor) and incremental load (replies only + cursors, no anchor).

**Files:**
- Source: `tmp/graphql-tweet-detail.json` (already captured)
- Create: `src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json`
- Create: `src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json`

- [ ] **Step 1: Extract initial fixture**

```bash
cd d:/src/zyb/site-use && node -e "
const data = require('./tmp/graphql-tweet-detail.json');
const td = data.find(d => d.endpoint === 'TweetDetail');
const fs = require('fs');
fs.writeFileSync(
  'src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json',
  JSON.stringify(td.body, null, 2)
);
console.log('Written initial fixture');
"
```

- [ ] **Step 2: Create incremental fixture**

The incremental fixture simulates a scroll-loaded response: no anchor tweet, only new replies + cursors. Build it by modifying the initial fixture structure.

```bash
cd d:/src/zyb/site-use && node -e "
const initial = require('./src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json');
const instructions = initial.data.threaded_conversation_with_injections_v2.instructions;
const addEntries = instructions.find(i => i.type === 'TimelineAddEntries');

// Keep only conversationthread entries (replies) and cursor entries
// Remove tweet-* (anchor) and tweetdetailrelatedtweets-* (recommended)
const entries = addEntries.entries.filter(e =>
  e.entryId.startsWith('conversationthread-') || e.entryId.startsWith('cursor-')
);

// Build incremental response: only TimelineAddEntries, no ClearCache/Terminate
const incremental = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [{
        type: 'TimelineAddEntries',
        entries,
      }],
    },
  },
};

const fs = require('fs');
fs.writeFileSync(
  'src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json',
  JSON.stringify(incremental, null, 2)
);
console.log('Written incremental fixture with', entries.length, 'entries');
"
```

- [ ] **Step 3: Verify fixtures load correctly**

```bash
cd d:/src/zyb/site-use && node -e "
const initial = require('./src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json');
const incremental = require('./src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json');

const initInst = initial.data.threaded_conversation_with_injections_v2.instructions;
const initEntries = initInst.find(i => i.type === 'TimelineAddEntries').entries;
console.log('Initial: instructions=' + initInst.length + ' entries=' + initEntries.length);

const incEntries = incremental.data.threaded_conversation_with_injections_v2.instructions[0].entries;
console.log('Incremental: entries=' + incEntries.length);

// Verify: initial has anchor, incremental does not
const hasAnchor = (entries) => entries.some(e => e.entryId.startsWith('tweet-'));
console.log('Initial has anchor:', hasAnchor(initEntries));
console.log('Incremental has anchor:', hasAnchor(incEntries));
"
```

Expected:
```
Initial: instructions=4 entries=13 (or similar)
Incremental: entries=11 (or similar, only replies + cursors)
Initial has anchor: true
Incremental has anchor: false
```

- [ ] **Step 4: Commit**

```bash
git add src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json
git commit -m "test: add TweetDetail GraphQL fixtures (initial + incremental)"
```

---

### Task 2: Add types — `TweetDetailParamsSchema` and `TweetDetailParsed`

**Files:**
- Modify: `src/sites/twitter/types.ts`
- Test: `src/sites/twitter/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/sites/twitter/__tests__/types.test.ts`:

```typescript
import { TweetDetailParamsSchema } from '../types.js';

describe('TweetDetailParamsSchema', () => {
  it('accepts valid x.com tweet URL with defaults', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/shawn_pana/status/2037688071144317428',
    });
    expect(result.url).toBe('https://x.com/shawn_pana/status/2037688071144317428');
    expect(result.count).toBe(20);
    expect(result.debug).toBe(false);
  });

  it('accepts twitter.com URL', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://twitter.com/user/status/123456',
    });
    expect(result.url).toBe('https://twitter.com/user/status/123456');
  });

  it('accepts URL with query params', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/user/status/123456?s=20&t=abc',
    });
    expect(result.url).toContain('123456');
  });

  it('rejects non-tweet URL', () => {
    expect(() => TweetDetailParamsSchema.parse({
      url: 'https://x.com/user',
    })).toThrow();
  });

  it('rejects non-URL string', () => {
    expect(() => TweetDetailParamsSchema.parse({
      url: 'not-a-url',
    })).toThrow();
  });

  it('accepts custom count', () => {
    const result = TweetDetailParamsSchema.parse({
      url: 'https://x.com/user/status/123',
      count: 50,
    });
    expect(result.count).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/types.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `TweetDetailParamsSchema` not found.

- [ ] **Step 3: Write the implementation**

Add to the end of `src/sites/twitter/types.ts` (before the closing, after `TwitterFeedParamsSchema`):

```typescript
// --- TweetDetailParams ---

const TWEET_URL_PATTERN = /^https:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/;

export const TweetDetailParamsSchema = z.object({
  url: z.string()
    .regex(TWEET_URL_PATTERN, 'Must be a tweet URL (https://x.com/{handle}/status/{id})')
    .describe('Tweet URL (https://x.com/{handle}/status/{id})'),
  count: z.number().min(1).max(100).default(20)
    .describe('Maximum number of replies to return'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
  dumpRaw: z.string().optional()
    .describe('Directory path to dump raw GraphQL responses'),
});

// --- TweetDetailParsed (extractor output) ---

export interface TweetDetailParsed {
  anchor: RawTweetData | null;
  replies: RawTweetData[];
  hasCursor: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/types.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/types.ts src/sites/twitter/__tests__/types.test.ts
git commit -m "feat(twitter): add TweetDetailParamsSchema and TweetDetailParsed type"
```

---

### Task 3: Implement `parseTweetDetail` extractor

**Files:**
- Modify: `src/sites/twitter/extractors.ts`
- Test: `src/sites/twitter/__tests__/extractors.test.ts`
- Read: `src/sites/twitter/__tests__/fixtures/tweet-detail-initial.json`
- Read: `src/sites/twitter/__tests__/fixtures/tweet-detail-incremental.json`

- [ ] **Step 1: Write the failing tests**

First, add `__dirname` declaration to `src/sites/twitter/__tests__/extractors.test.ts` (after the existing imports, before `RAW_TWEET`). The file already imports `fs`, `path`, `fileURLToPath` — just add the derived constant:

```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Then update the import to include `parseTweetDetail`:

```typescript
import {
  parseTweet,
  buildFeedMeta,
  parseGraphQLTimeline,
  parseTweetDetail,
  processFullText,
} from '../extractors.js';
```

Then add a new `describe('parseTweetDetail')` block at the end of the file:

```typescript
describe('parseTweetDetail', () => {

  it('extracts anchor and replies from initial response', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.authorHandle).toBe('shawn_pana');
    expect(result.replies.length).toBeGreaterThan(0);
    // Replies should not include the anchor tweet
    expect(result.replies.every(r => r.url !== result.anchor!.url)).toBe(true);
    // No recommended tweets (tweetdetailrelatedtweets) in replies
    expect(result.hasCursor).toBe(true);
  });

  it('returns null anchor for incremental response', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-incremental.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    expect(result.anchor).toBeNull();
    expect(result.replies.length).toBeGreaterThan(0);
  });

  it('extracts replies with inReplyTo field', () => {
    const body = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );
    const result = parseTweetDetail(body);

    // At least some replies should have inReplyTo
    const withInReplyTo = result.replies.filter(r => r.inReplyTo != null);
    expect(withInReplyTo.length).toBeGreaterThan(0);
    expect(withInReplyTo[0].inReplyTo!.handle).toBe('shawn_pana');
  });

  it('returns empty result for malformed body', () => {
    const result = parseTweetDetail('{}');
    expect(result.anchor).toBeNull();
    expect(result.replies).toEqual([]);
    expect(result.hasCursor).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/extractors.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `parseTweetDetail` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/sites/twitter/extractors.ts`, after `parseGraphQLTimeline` and before the final `export { GRAPHQL_TIMELINE_PATTERN }`:

```typescript
const GRAPHQL_TWEET_DETAIL_PATTERN = /\/i\/api\/graphql\/.*\/TweetDetail/;

/** Parse GraphQL TweetDetail response into anchor + replies. */
export function parseTweetDetail(body: string): TweetDetailParsed {
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return { anchor: null, replies: [], hasCursor: false };
  }

  const instructions =
    data?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];

  const addEntries = instructions.find(
    (i: any) => i.type === 'TimelineAddEntries',
  );
  if (!addEntries) return { anchor: null, replies: [], hasCursor: false };

  let anchor: RawTweetData | null = null;
  const replies: RawTweetData[] = [];
  let hasCursor = false;

  for (const entry of addEntries.entries ?? []) {
    const entryId: string = entry.entryId ?? '';

    if (entryId.startsWith('tweet-')) {
      // Anchor tweet
      const itemContent = entry.content?.itemContent;
      if (itemContent?.__typename === 'TimelineTweet') {
        const tweetResult = itemContent.tweet_results?.result;
        if (tweetResult) {
          const extracted = extractFromTweetResult(tweetResult);
          if (extracted) anchor = extracted;
        }
      }
    } else if (entryId.startsWith('conversationthread-')) {
      // Reply thread module — extract all items
      for (const moduleItem of entry.content?.items ?? []) {
        const itemContent = moduleItem?.item?.itemContent;
        if (itemContent?.__typename !== 'TimelineTweet') continue;
        const tweetResult = itemContent.tweet_results?.result;
        if (!tweetResult) continue;
        const extracted = extractFromTweetResult(tweetResult);
        if (extracted) replies.push(extracted);
      }
    } else if (entryId.startsWith('cursor-bottom')) {
      hasCursor = true;
    }
    // tweetdetailrelatedtweets-* and other entries are silently skipped
  }

  return { anchor, replies, hasCursor };
}

export { GRAPHQL_TIMELINE_PATTERN, GRAPHQL_TWEET_DETAIL_PATTERN };
```

Also add the import at the top of `extractors.ts`:

```typescript
import type { Tweet, TweetMedia, RawTweetData, RawTweetMedia, FeedMeta, TweetDetailParsed } from './types.js';
```

And remove the old `export { GRAPHQL_TIMELINE_PATTERN }` at the bottom (it's now combined in the new export statement).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/extractors.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS — all existing tests + 4 new `parseTweetDetail` tests.

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/extractors.ts src/sites/twitter/__tests__/extractors.test.ts
git commit -m "feat(twitter): add parseTweetDetail extractor for tweet detail GraphQL responses"
```

---

### Task 4: Implement `ensureTweetDetail` and `getTweetDetail` workflow

**Files:**
- Modify: `src/sites/twitter/workflows.ts`
- Test: `src/sites/twitter/__tests__/workflows.test.ts`

- [ ] **Step 1: Write the failing tests for `ensureTweetDetail`**

Add to `src/sites/twitter/__tests__/workflows.test.ts`:

```typescript
import type { RawTweetData } from '../types.js';

let ensureTweetDetail: typeof import('../workflows.js').ensureTweetDetail;
let getTweetDetail: typeof import('../workflows.js').getTweetDetail;

// Add to the existing beforeEach:
beforeEach(async () => {
  const mod = await import('../workflows.js');
  checkLogin = mod.checkLogin;
  getFeed = mod.getFeed;
  ensureTimeline = mod.ensureTimeline;
  collectData = mod.collectData;
  ensureTweetDetail = mod.ensureTweetDetail;
  getTweetDetail = mod.getTweetDetail;
});

describe('ensureTweetDetail', () => {
  it('navigates to the tweet URL and waits for data', async () => {
    const collector = createDataCollector<RawTweetData>();
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        // Simulate GraphQL response arriving after navigation
        setTimeout(() => collector.push({
          authorHandle: 'test',
          authorName: 'Test',
          following: false,
          text: 'reply text',
          timestamp: '2026-03-28T00:00:00.000Z',
          url: 'https://x.com/test/status/111',
          likes: 0, retweets: 0, replies: 0,
          media: [], links: [],
          isRetweet: false, isAd: false,
          surfaceReason: 'reply',
          inReplyTo: { handle: 'author', tweetId: '100' },
        }), 50);
      }),
      evaluate: vi.fn().mockResolvedValue('https://x.com/author/status/100'),
    });

    const result = await ensureTweetDetail(primitives, collector, {
      url: 'https://x.com/author/status/100',
      t0: Date.now(),
    });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/author/status/100');
    expect(result.reloaded).toBe(false);
    expect(collector.length).toBe(1);
  });

  it('reloads when no data arrives within timeout', { timeout: 10000 }, async () => {
    const collector = createDataCollector<RawTweetData>();
    let navigateCount = 0;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        navigateCount++;
        // Push data only on second navigate (reload)
        if (navigateCount === 2) {
          setTimeout(() => collector.push({
            authorHandle: 'test', authorName: 'Test', following: false,
            text: 'reply', timestamp: '2026-03-28T00:00:00.000Z',
            url: 'https://x.com/test/status/111',
            likes: 0, retweets: 0, replies: 0,
            media: [], links: [], isRetweet: false, isAd: false,
            surfaceReason: 'reply',
          }), 50);
        }
      }),
      evaluate: vi.fn().mockResolvedValue('https://x.com/author/status/100'),
    });

    const result = await ensureTweetDetail(primitives, collector, {
      url: 'https://x.com/author/status/100',
      t0: Date.now(),
    });

    expect(result.reloaded).toBe(true);
    expect(primitives.navigate).toHaveBeenCalledTimes(2);
  });

  it('throws SessionExpired when redirected to login', async () => {
    const collector = createDataCollector<RawTweetData>();
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/i/flow/login'),
    });

    await expect(
      ensureTweetDetail(primitives, collector, {
        url: 'https://x.com/author/status/100',
        t0: Date.now(),
      }),
    ).rejects.toThrow('Not logged in');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/workflows.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `ensureTweetDetail` is not exported.

- [ ] **Step 3: Implement `ensureTweetDetail`**

Add to `src/sites/twitter/workflows.ts`:

```typescript
import {
  parseGraphQLTimeline,
  parseTweet,
  buildFeedMeta,
  parseTweetDetail,
  GRAPHQL_TIMELINE_PATTERN,
  GRAPHQL_TWEET_DETAIL_PATTERN,
} from './extractors.js';
import type { RawTweetData, TweetDetailParsed } from './types.js';

export interface EnsureTweetDetailResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

/**
 * Navigate to tweet detail page and wait for GraphQL data.
 * Checks for login redirect. Falls back to reload if no data arrives.
 */
export async function ensureTweetDetail(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { url: string; t0: number },
): Promise<EnsureTweetDetailResult> {
  const { url, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  // Step 1: Navigate to tweet detail page
  await primitives.navigate(url);

  // Step 2: Check for login redirect
  const currentUrl = await primitives.evaluate<string>('window.location.href');
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', { retryable: false });
  }

  // Step 3: Wait for initial data
  const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);

  // Step 4: Fallback — reload if no data
  if (!hasData) {
    reloaded = true;
    collector.clear();
    await primitives.navigate(url);
    await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
  }

  return { reloaded, waits };
}
```

Also add the import for `SiteUseError` at the top of `workflows.ts`:

```typescript
import { SiteUseError } from '../../errors.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/workflows.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS — existing tests + 3 new `ensureTweetDetail` tests.

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/workflows.ts src/sites/twitter/__tests__/workflows.test.ts
git commit -m "feat(twitter): add ensureTweetDetail — navigate + wait + login check + reload fallback"
```

---

### Task 5: Implement `getTweetDetail` workflow

**Files:**
- Modify: `src/sites/twitter/workflows.ts`
- Test: `src/sites/twitter/__tests__/workflows.test.ts`

- [ ] **Step 1: Write the failing test**

First, add file system imports and `__dirname` to `src/sites/twitter/__tests__/workflows.test.ts` (after existing imports):

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Then add the test block:

```typescript
describe('getTweetDetail', () => {
  it('returns anchor as items[0] and replies as items[1..n]', async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );

    let interceptHandler: ((response: { url: string; status: number; body: string }) => void) | null = null;

    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {}; // cleanup
      }),
      navigate: vi.fn().mockImplementation(async () => {
        // Simulate GraphQL response arriving after navigation
        if (interceptHandler) {
          setTimeout(() => {
            interceptHandler!({
              url: 'https://x.com/i/api/graphql/abc/TweetDetail',
              status: 200,
              body: fixtureBody,
            });
          }, 50);
        }
      }),
      evaluate: vi.fn().mockResolvedValue('https://x.com/shawn_pana/status/2037688071144317428'),
    });

    const result = await getTweetDetail(primitives, {
      url: 'https://x.com/shawn_pana/status/2037688071144317428',
      count: 20,
    });

    // items[0] is anchor
    expect(result.items[0].author.handle).toBe('shawn_pana');
    expect(result.items[0].siteMeta).not.toHaveProperty('inReplyTo');
    // items[1..n] are replies
    expect(result.items.length).toBeGreaterThan(1);
    // meta
    expect(result.meta.coveredUsers).toContain('shawn_pana');
    expect(result.meta.timeRange.from).toBeTruthy();
    expect(result.meta.timeRange.to).toBeTruthy();
  });

  it('filters out ads from replies', async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );

    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockImplementation(async (_p: any, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          setTimeout(() => interceptHandler({
            url: 'https://x.com/i/api/graphql/abc/TweetDetail',
            status: 200,
            body: fixtureBody,
          }), 50);
        }
      }),
      evaluate: vi.fn().mockResolvedValue('https://x.com/shawn_pana/status/2037688071144317428'),
    });

    const result = await getTweetDetail(primitives, {
      url: 'https://x.com/shawn_pana/status/2037688071144317428',
    });

    // No ads in result
    const hasAd = result.items.some(item =>
      (item.siteMeta as any).isAd === true
    );
    expect(hasAd).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/workflows.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `getTweetDetail` not exported or not defined.

- [ ] **Step 3: Implement `getTweetDetail`**

Add to `src/sites/twitter/workflows.ts`:

```typescript
export interface GetTweetDetailOptions {
  url: string;
  count?: number;
  debug?: boolean;
  dumpRaw?: string;
}

/**
 * Fetch a tweet and its replies.
 * Sets up GraphQL interception, navigates to the tweet detail page,
 * collects replies via scroll, and returns anchor + replies as FeedResult.
 */
export async function getTweetDetail(
  primitives: Primitives,
  opts: GetTweetDetailOptions,
): Promise<FrameworkFeedResult> {
  const { url, count = 20, debug = false, dumpRaw } = opts;
  const t0 = Date.now();
  let graphqlResponseCount = 0;
  let graphqlParseFailures = 0;

  // Anchor is stored separately; only replies go into collector.
  // hasCursor tracks whether more replies can be loaded (from latest GraphQL response).
  let anchor: RawTweetData | null = null;
  let hasCursor = false;
  const collector = createDataCollector<RawTweetData>();
  let dumpIndex = 0;

  const cleanup = await primitives.interceptRequest(
    GRAPHQL_TWEET_DETAIL_PATTERN,
    (response) => {
      try {
        if (dumpRaw) {
          fs.mkdirSync(dumpRaw, { recursive: true });
          const outPath = path.join(dumpRaw, `tweet-detail-${dumpIndex++}.json`);
          fs.writeFileSync(outPath, response.body);
        }
        const parsed = parseTweetDetail(response.body);
        if (parsed.anchor && !anchor) {
          anchor = parsed.anchor;
        }
        hasCursor = parsed.hasCursor;
        if (parsed.replies.length > 0) {
          collector.push(...parsed.replies);
        }
        graphqlResponseCount++;
      } catch {
        graphqlParseFailures++;
      }
    },
  );

  try {
    const ensureResult = await ensureTweetDetail(primitives, collector, { url, t0 });

    // Only scroll for more if we need more replies AND there are more to load
    let collectResult: CollectDataResult = { scrollRounds: 0, waits: [] };
    if (collector.length < count && hasCursor) {
      collectResult = await collectData(primitives, collector, { count, t0 });
    }

    // Build items: anchor first, then replies
    const allRaw = anchor ? [anchor, ...collector.items] : [...collector.items];
    const tweets = allRaw
      .map(parseTweet)
      .filter((t) => !t.isAd);

    // Trim replies to count (anchor doesn't count toward limit)
    const anchorTweet = anchor ? tweets[0] : undefined;
    const replyTweets = anchor ? tweets.slice(1, count + 1) : tweets.slice(0, count);
    const finalTweets = anchorTweet ? [anchorTweet, ...replyTweets] : replyTweets;

    const meta = buildFeedMeta(finalTweets);
    const items = finalTweets.map(tweetToFeedItem);

    const frameworkResult: FrameworkFeedResult = {
      items,
      meta: {
        coveredUsers: meta.coveredUsers,
        timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
      },
    };

    if (debug) {
      frameworkResult.debug = {
        graphqlResponseCount,
        graphqlParseFailures,
        rawRepliesBeforeFilter: collector.length,
        elapsedMs: Date.now() - t0,
        ensureTweetDetail: ensureResult,
        collectData: collectResult,
      };
    }

    return frameworkResult;
  } finally {
    cleanup();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd d:/src/zyb/site-use && pnpm run build && pnpm vitest run src/sites/twitter/__tests__/workflows.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS — all existing + new tests.

- [ ] **Step 5: Run all tests to check nothing is broken**

```bash
cd d:/src/zyb/site-use && pnpm test 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/workflows.ts src/sites/twitter/__tests__/workflows.test.ts
git commit -m "feat(twitter): add getTweetDetail workflow — anchor + replies via GraphQL interception"
```

---

### Task 6: Register `customWorkflows` in plugin

**Files:**
- Modify: `src/sites/twitter/index.ts`

- [ ] **Step 1: Write the failing test**

No dedicated test file — the registration is verified by the integration test: after this change, `generateMcpTools` should produce a tool named `twitter_tweet_detail`. But we verify via build + existing test suite. A quick manual check:

```bash
cd d:/src/zyb/site-use && pnpm run build && node -e "
const { plugin } = require('./dist/sites/twitter/index.js');
console.log('customWorkflows:', plugin.customWorkflows?.map(w => w.name));
"
```

Expected before change: `customWorkflows: undefined`

- [ ] **Step 2: Register the workflow**

In `src/sites/twitter/index.ts`, add the import and `customWorkflows` field:

```typescript
import { checkLogin, getFeed, getTweetDetail } from './workflows.js';
import { TweetDetailParamsSchema } from './types.js';

// Inside the plugin object, after capabilities:
  customWorkflows: [
    {
      name: 'tweet_detail',
      description: 'Get a tweet with its replies. Returns the original tweet (with full text) as items[0] and replies as items[1..n].',
      params: TweetDetailParamsSchema,
      execute: (primitives: Primitives, params: unknown) =>
        getTweetDetail(primitives, params as Parameters<typeof getTweetDetail>[1]),
      expose: ['mcp', 'cli'],
      cli: {
        description: 'Get a tweet and its replies',
        help: `Options:\n  --url <url>             Tweet URL (required)\n  --count <n>            Max replies (1-100, default: 20)\n  --debug                Include diagnostic info`,
      },
    },
  ],
```

- [ ] **Step 3: Build and verify**

```bash
cd d:/src/zyb/site-use && pnpm run build && node -e "
const { plugin } = require('./dist/sites/twitter/index.js');
console.log('customWorkflows:', plugin.customWorkflows?.map(w => w.name));
console.log('params keys:', Object.keys(plugin.customWorkflows[0].params.shape));
"
```

Expected:
```
customWorkflows: [ 'tweet_detail' ]
params keys: [ 'url', 'count', 'debug', 'dumpRaw' ]
```

- [ ] **Step 4: Run all tests**

```bash
cd d:/src/zyb/site-use && pnpm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/index.ts
git commit -m "feat(twitter): register tweet_detail as customWorkflow — MCP + CLI auto-generated"
```

---

### Task 7: End-to-end verification

**Files:** None modified — verification only.

- [ ] **Step 1: Build**

```bash
cd d:/src/zyb/site-use && pnpm run build
```

- [ ] **Step 2: Run full test suite**

```bash
cd d:/src/zyb/site-use && pnpm test
```

Expected: All tests pass.

- [ ] **Step 3: Verify MCP tool registration**

```bash
cd d:/src/zyb/site-use && node -e "
const { plugin } = require('./dist/sites/twitter/index.js');
const wf = plugin.customWorkflows[0];
console.log('Tool name: twitter_' + wf.name);
console.log('Description:', wf.description);
console.log('Expose:', wf.expose);
console.log('Has execute:', typeof wf.execute === 'function');
console.log('Has params:', !!wf.params);
"
```

- [ ] **Step 4: Verify CLI help**

```bash
cd d:/src/zyb/site-use && node dist/index.js twitter tweet_detail --help
```

Expected: Shows usage info with `--url`, `--count`, `--debug` options.

- [ ] **Step 5: Live test with dumpRaw (optional, requires browser)**

```bash
cd d:/src/zyb/site-use && node dist/index.js twitter tweet_detail --url "https://x.com/shawn_pana/status/2037688071144317428" --count 5 --dump-raw tmp/tweet-detail-dump
```

Expected: Returns JSON with `items[0]` being the anchor tweet by `shawn_pana`, followed by up to 5 replies. Raw GraphQL dumped to `tmp/tweet-detail-dump/`.
