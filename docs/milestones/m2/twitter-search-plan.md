# Twitter Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `site-use twitter search` CLI command that searches Twitter via browser automation, intercepts GraphQL responses, and returns structured tweet data.

**Architecture:** Register search as a `customWorkflows` entry (same pattern as `tweet_detail`). Reuse existing `processEntries()` and `parseTweet()` for tweet extraction. Only new code: GraphQL search response parser, search page navigation, Zod params schema, and a contract test with raw fixture data.

**Tech Stack:** TypeScript, Zod, Puppeteer (via Primitives), Vitest

**Design doc:** `docs/milestones/m2/twitter-search-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/sites/twitter/extractors.ts` | Modify | Add `parseGraphQLSearch()`, export `GRAPHQL_SEARCH_PATTERN` |
| `src/sites/twitter/types.ts` | Modify | Add `TwitterSearchParamsSchema` |
| `src/sites/twitter/workflows.ts` | Modify | Add `getSearch()` and `ensureSearch()` |
| `src/sites/twitter/index.ts` | Modify | Register search in `customWorkflows` |
| `tests/unit/twitter-search-extractor.test.ts` | Create | Unit tests for `parseGraphQLSearch()` |
| `tests/contract/plugin-contract.test.ts` | Modify | Add search workflow contract test |
| `tests/fixtures/twitter-search-response-0.json` | Create | Trimmed fixture from `tmp-search-raw/search-response-0.json` |
| `tests/fixtures/twitter-search-response-1.json` | Create | Trimmed fixture from `tmp-search-raw/search-response-1.json` |

---

### Task 1: Add `parseGraphQLSearch()` extractor

**Files:**
- Modify: `src/sites/twitter/extractors.ts`
- Create: `tests/unit/twitter-search-extractor.test.ts`
- Create: `tests/fixtures/twitter-search-response-0.json`
- Create: `tests/fixtures/twitter-search-response-1.json`

- [ ] **Step 1: Prepare fixture files**

Copy trimmed fixtures from `tmp-search-raw/`. Keep only the first 3 tweet entries + cursors from response-0, and first 3 tweet entries from response-1, to keep file size small. Remove the `TimelineTimelineModule` (user recommendations) from response-0 — it should be skipped by the parser.

Run:
```bash
node -e "
const fs = require('fs');
const r0 = JSON.parse(fs.readFileSync('tmp-search-raw/search-response-0.json','utf-8'));
const timeline0 = r0.data.search_by_raw_query.search_timeline.timeline;
const entries0 = timeline0.instructions[0].entries;
// Keep: first 3 TimelineTimelineItem + both cursors + the module (to test it gets skipped)
const kept0 = [
  entries0.find(e => e.content?.entryType === 'TimelineTimelineModule'),
  ...entries0.filter(e => e.content?.entryType === 'TimelineTimelineItem').slice(0, 3),
  ...entries0.filter(e => e.content?.entryType === 'TimelineTimelineCursor'),
].filter(Boolean);
timeline0.instructions[0].entries = kept0;
fs.writeFileSync('tests/fixtures/twitter-search-response-0.json', JSON.stringify(r0, null, 2));

const r1 = JSON.parse(fs.readFileSync('tmp-search-raw/search-response-1.json','utf-8'));
const timeline1 = r1.data.search_by_raw_query.search_timeline.timeline;
const addEntries1 = timeline1.instructions.find(i => i.type === 'TimelineAddEntries');
addEntries1.entries = addEntries1.entries.slice(0, 3);
fs.writeFileSync('tests/fixtures/twitter-search-response-1.json', JSON.stringify(r1, null, 2));
console.log('Fixtures created');
"
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/unit/twitter-search-extractor.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGraphQLSearch } from '../../src/sites/twitter/extractors.js';

const FIXTURES_DIR = path.join(import.meta.dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseGraphQLSearch', () => {
  it('parses initial search response with tweets (skips user module)', () => {
    const body = readFixture('twitter-search-response-0.json');
    const results = parseGraphQLSearch(body);
    // Fixture has 3 tweet entries + 1 user module + 2 cursors
    // Parser should return only the 3 tweets
    expect(results.length).toBe(3);
    for (const tweet of results) {
      expect(tweet.authorHandle).toBeTruthy();
      expect(tweet.text).toBeTruthy();
      expect(tweet.timestamp).toBeTruthy();
      expect(tweet.url).toContain('x.com');
    }
  });

  it('parses scroll (paginated) search response', () => {
    const body = readFixture('twitter-search-response-1.json');
    const results = parseGraphQLSearch(body);
    expect(results.length).toBe(3);
    for (const tweet of results) {
      expect(tweet.authorHandle).toBeTruthy();
      expect(tweet.text).toBeTruthy();
    }
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseGraphQLSearch('not json')).toEqual([]);
  });

  it('returns empty array for empty instructions', () => {
    const body = JSON.stringify({
      data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } },
    });
    expect(parseGraphQLSearch(body)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/twitter-search-extractor.test.ts`
Expected: FAIL — `parseGraphQLSearch` is not exported

- [ ] **Step 4: Implement `parseGraphQLSearch`**

In `src/sites/twitter/extractors.ts`, add after the existing `parseGraphQLTimeline` function:

```typescript
const GRAPHQL_SEARCH_PATTERN = /\/i\/api\/graphql\/.*\/SearchTimeline/;

/** Parse GraphQL SearchTimeline response into RawTweetData[]. */
export function parseGraphQLSearch(body: string): RawTweetData[] {
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }

  const instructions =
    data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  const results: RawTweetData[] = [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries') {
      processEntries(instruction.entries ?? [], results);
    }
  }

  return results;
}
```

And update the export at the bottom:

```typescript
export { GRAPHQL_TIMELINE_PATTERN, GRAPHQL_TWEET_DETAIL_PATTERN, GRAPHQL_SEARCH_PATTERN };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/twitter-search-extractor.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 6: Build**

Run: `pnpm run build`
Expected: Clean build, no errors

- [ ] **Step 7: Commit**

```bash
git add src/sites/twitter/extractors.ts tests/unit/twitter-search-extractor.test.ts tests/fixtures/twitter-search-response-0.json tests/fixtures/twitter-search-response-1.json
git commit -m "feat: add parseGraphQLSearch extractor for Twitter search responses"
```

---

### Task 2: Add `TwitterSearchParamsSchema`

**Files:**
- Modify: `src/sites/twitter/types.ts`

- [ ] **Step 1: Add schema**

In `src/sites/twitter/types.ts`, add after `TweetDetailParamsSchema`:

```typescript
// --- TwitterSearchParams ---

export type SearchTab = 'top' | 'latest';

export const TwitterSearchParamsSchema = z.object({
  query: z.string().min(1)
    .describe('Search query (supports Twitter search operators like from:user, min_faves:100, since:2026-01-01)'),
  tab: z.enum(['top', 'latest']).default('top')
    .describe('Search tab: "top" (relevance) or "latest" (chronological)'),
  count: z.number().min(1).max(100).default(20)
    .describe('Number of tweets to collect'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
  dumpRaw: z.string().optional()
    .describe('Directory path to dump raw GraphQL responses'),
});
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/sites/twitter/types.ts
git commit -m "feat: add TwitterSearchParamsSchema"
```

---

### Task 3: Add `getSearch()` workflow

**Files:**
- Modify: `src/sites/twitter/workflows.ts`

- [ ] **Step 1: Add imports**

At the top of `workflows.ts`, add `parseGraphQLSearch` and `GRAPHQL_SEARCH_PATTERN` to the import from `./extractors.js`:

```typescript
import {
  parseGraphQLTimeline,
  parseTweet,
  buildFeedMeta,
  parseTweetDetail,
  parseGraphQLSearch,
  GRAPHQL_TIMELINE_PATTERN,
  GRAPHQL_TWEET_DETAIL_PATTERN,
  GRAPHQL_SEARCH_PATTERN,
} from './extractors.js';
```

Add the `SearchTab` type import from `./types.js`:

```typescript
import type { RawTweetData } from './types.js';
```

Change to:

```typescript
import type { RawTweetData, SearchTab } from './types.js';
```

- [ ] **Step 2: Add `ensureSearch()` function**

Add after `ensureTweetDetail`:

```typescript
export interface EnsureSearchResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

/**
 * Navigate to Twitter search page and wait for GraphQL data.
 * Builds the search URL from query and tab, then waits for SearchTimeline response.
 */
export async function ensureSearch(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { query: string; tab: SearchTab; t0: number },
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsureSearchResult> {
  const { query, tab, t0 } = opts;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  // Build search URL
  const tabParam = tab === 'latest' ? '&f=live' : '';
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${tabParam}`;

  // Step 1: Navigate to search page
  console.error(`[site-use] searching: "${query}" (tab: ${tab})...`);
  await span.span('navigate', async () => {
    await primitives.navigate(searchUrl);
  });

  // Step 2: Check for login redirect
  await span.span('checkLogin', async (s) => {
    const currentUrl = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', currentUrl);
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', { retryable: false });
    }
  });

  // Step 3: Wait for initial data
  console.error('[site-use] waiting for search results...');
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, WAIT_FOR_DATA_MS);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData) {
      console.error('[site-use] no data yet, reloading page...');
      reloaded = true;
      collector.clear();
      await primitives.navigate(searchUrl);
      const hasDataAfterReload = await timedWait('after_reload', () => collector.length > 0, WAIT_FOR_DATA_MS);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', hasDataAfterReload);
      s.set('dataCountAfterReload', collector.length);
    }
  });

  return { reloaded, waits };
}
```

- [ ] **Step 3: Add `getSearch()` function**

Add after `ensureSearch`:

```typescript
export interface GetSearchOptions {
  query: string;
  tab?: SearchTab;
  count?: number;
  dumpRaw?: string;
}

/**
 * Search Twitter and collect results.
 * Sets up GraphQL interception, navigates to search page,
 * scrolls to collect results, returns as FeedResult.
 */
export async function getSearch(
  primitives: Primitives,
  opts: GetSearchOptions,
  trace: Trace = NOOP_TRACE,
): Promise<FrameworkFeedResult> {
  const { query, tab = 'top', count = 20, dumpRaw } = opts;
  const t0 = Date.now();

  return await trace.span('getSearch', async (rootSpan) => {
    rootSpan.set('query', query);
    rootSpan.set('tab', tab);
    rootSpan.set('count', count);
    let graphqlCount = 0;
    let graphqlFailures = 0;

    const collector = createDataCollector<RawTweetData>();
    let dumpIndex = 0;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_SEARCH_PATTERN,
      (response) => {
        try {
          if (dumpRaw) {
            fs.mkdirSync(dumpRaw, { recursive: true });
            const outPath = path.join(dumpRaw, `search-${dumpIndex++}.json`);
            fs.writeFileSync(outPath, response.body);
          }
          const parsed = parseGraphQLSearch(response.body);
          collector.push(...parsed);
          graphqlCount++;
          rootSpan.set('graphqlResponses', graphqlCount);
        } catch {
          graphqlFailures++;
          rootSpan.set('graphqlFailures', graphqlFailures);
        }
      },
    );

    try {
      await rootSpan.span('ensureSearch', async (s) => {
        await ensureSearch(primitives, collector, { query, tab, t0 }, s);
      });

      if (collector.length < count) {
        await rootSpan.span('collectData', async (s) => {
          await collectData(primitives, collector, { count, t0 }, s);
        });
      }

      const tweets = [...collector.items]
        .map(parseTweet)
        .filter((t) => !t.isAd)
        .slice(0, count);

      if (tweets.length === 0) {
        console.error(`[site-use] no tweets found for "${query}"`);
      }

      const meta = buildFeedMeta(tweets);
      const items = tweets.map(tweetToFeedItem);

      rootSpan.set('rawBeforeFilter', collector.length);
      rootSpan.set('itemsReturned', items.length);

      return {
        items,
        meta: {
          coveredUsers: meta.coveredUsers,
          timeRange: { from: meta.timeRange.from, to: meta.timeRange.to },
        },
      };
    } finally {
      cleanup();
    }
  });
}
```

- [ ] **Step 4: Build**

Run: `pnpm run build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add src/sites/twitter/workflows.ts
git commit -m "feat: add getSearch workflow for Twitter search"
```

---

### Task 4: Register search as custom workflow

**Files:**
- Modify: `src/sites/twitter/index.ts`
- Modify: `tests/contract/plugin-contract.test.ts`

- [ ] **Step 1: Add import and register in plugin**

In `src/sites/twitter/index.ts`, add `getSearch` to the import from `./workflows.js`:

```typescript
import { checkLogin, getFeed, getTweetDetail, getSearch } from './workflows.js';
```

Add `TwitterSearchParamsSchema` to the import from `./types.js`:

```typescript
import { TwitterFeedParamsSchema, TweetDetailParamsSchema, TwitterSearchParamsSchema } from './types.js';
```

Add the search workflow entry to the `customWorkflows` array, after the `tweet_detail` entry:

```typescript
{
  name: 'search',
  description:
    'Search Twitter for tweets matching a query. Supports Twitter search operators ' +
    '(from:user, min_faves:N, since:YYYY-MM-DD, filter:media, lang:en, etc.). ' +
    'Returns structured tweet data. Use "top" tab for relevance or "latest" for chronological.',
  params: TwitterSearchParamsSchema,
  execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
    getSearch(primitives, params as Parameters<typeof getSearch>[1], trace),
  expose: ['cli'],
  cli: {
    description: 'Search tweets on Twitter',
    help: `Options:\n  --query <text>         Search query (required, supports Twitter operators)\n  --tab <name>           Search tab: top | latest (default: top)\n  --count <n>            Number of tweets (1-100, default: 20)\n  --dump-raw <dir>       Save raw GraphQL responses to directory\n  --debug                Include diagnostic info`,
  },
},
```

- [ ] **Step 2: Add contract test**

In `tests/contract/plugin-contract.test.ts`, add a test inside the existing `describe('Plugin Contract')` block:

```typescript
it('twitter plugin registers search workflow with correct schema', async () => {
  const { plugin } = await import('../../src/sites/twitter/index.js');
  const searchWf = plugin.customWorkflows?.find(w => w.name === 'search');
  expect(searchWf).toBeDefined();
  expect(searchWf!.expose).toEqual(['cli']);
  expect(searchWf!.description).toContain('Search Twitter');

  // Validate params schema accepts valid input
  const validResult = searchWf!.params.safeParse({ query: 'AI agents' });
  expect(validResult.success).toBe(true);

  // Validate defaults
  const parsed = searchWf!.params.parse({ query: 'test' });
  expect(parsed).toMatchObject({ query: 'test', tab: 'top', count: 20, debug: false });

  // Validate rejects empty query
  const emptyResult = searchWf!.params.safeParse({ query: '' });
  expect(emptyResult.success).toBe(false);
});
```

- [ ] **Step 3: Run contract test**

Run: `npx vitest run tests/contract/plugin-contract.test.ts`
Expected: PASS

- [ ] **Step 4: Verify `search` is no longer a reserved name conflict**

The `RESERVED_NAMES` in `registry/validation.ts` includes `'search'`. But `customWorkflows` names are validated per-plugin as `{site}_{name}` for MCP tools, and CLI commands are `{site} {name}`. The reserved names check only applies to **plugin names** (the `name` field of `SitePlugin`), not to workflow names. So there is no conflict — `search` as a workflow name under the `twitter` plugin is fine.

Verify by checking the validation test still passes:

Run: `npx vitest run tests/unit/registry-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Build and run full test suite**

Run: `pnpm run build && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/sites/twitter/index.ts tests/contract/plugin-contract.test.ts
git commit -m "feat: register twitter search as custom workflow (CLI only)"
```

---

### Task 5: Manual smoke test

**Files:** (none — manual verification)

- [ ] **Step 1: Verify help output**

Run: `npx site-use twitter --help`
Expected: `search` appears in the command list

Run: `npx site-use twitter search --help`
Expected: Shows search options (--query, --tab, --count, --debug) plus framework output options (--fields, --quiet)

- [ ] **Step 2: Verify search works**

Run: `npx site-use twitter search --query "AI" --count 5 --quiet`
Expected: stderr shows progress messages, one-line summary like "Synced 5 tweets"

Run: `npx site-use twitter search --query "AI" --count 3 --tab latest`
Expected: JSON output with 3 tweets, chronologically ordered

- [ ] **Step 3: Verify --fields filter works**

Run: `npx site-use twitter search --query "AI" --count 3 --fields author,text,url`
Expected: Each item only has id, site, author, text, url fields

- [ ] **Step 4: Verify --dump-raw works**

Run: `npx site-use twitter search --query "AI" --count 3 --dump-raw`
Expected: stderr shows dump directory path, raw JSON files created in `~/.site-use/dump/twitter/`

- [ ] **Step 5: Verify search operators work**

Run: `npx site-use twitter search --query "from:elonmusk min_faves:1000" --count 3 --fields author,text`
Expected: All results are from elonmusk with high engagement

- [ ] **Step 6: Verify global search is unaffected**

Run: `npx site-use search --help`
Expected: Still shows the global search help (not "unknown command")
