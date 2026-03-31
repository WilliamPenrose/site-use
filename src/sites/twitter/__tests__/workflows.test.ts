import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Primitives, SnapshotNode, Snapshot } from '../../../primitives/types.js';
import { TwitterFeedParamsSchema } from '../types.js';
import { createDataCollector } from '../../../ops/data-collector.js';
import type { RawTweetData } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    scrollIntoView: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('base64png'),
    interceptRequest: vi.fn().mockResolvedValue(() => {}),
    getRawPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function buildSnapshot(nodes: SnapshotNode[]): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) idToNode.set(node.uid, node);
  return { idToNode };
}

let checkLogin: typeof import('../workflows.js').checkLogin;
let getFeed: typeof import('../workflows.js').getFeed;
let ensureTimeline: typeof import('../workflows.js').ensureTimeline;
let collectData: typeof import('../workflows.js').collectData;
let ensureTweetDetail: typeof import('../workflows.js').ensureTweetDetail;
let getTweetDetail: typeof import('../workflows.js').getTweetDetail;
let ensureTab: typeof import('../workflows.js').ensureTab;

beforeEach(async () => {
  const mod = await import('../workflows.js');
  checkLogin = mod.checkLogin;
  getFeed = mod.getFeed;
  ensureTimeline = mod.ensureTimeline;
  collectData = mod.collectData;
  ensureTweetDetail = mod.ensureTweetDetail;
  getTweetDetail = mod.getTweetDetail;
  ensureTab = mod.ensureTab;
});

describe('checkLogin', () => {
  it('returns loggedIn: false when URL redirects to login', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/i/flow/login'),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(false);
  });

  it('returns loggedIn: true when Home link found in snapshot', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'Following', selected: true },
        ]),
      ),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(true);
  });

  it('returns loggedIn: false when no Home link in snapshot', { timeout: 15000 }, async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([{ uid: '1', role: 'button', name: 'Settings' }]),
      ),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(false);
  });

  it('navigates to x.com/home', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'Following', selected: true },
        ]),
      ),
    });
    await checkLogin(primitives);
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home');
  });
});

describe('getFeed', () => {
  it('navigates to x.com/home directly (auth guard handles login check)', { timeout: 15000 }, async () => {
    const GRAPHQL_BODY = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{ entries: [] }],
          },
        },
      },
    });

    let interceptHandler: any;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          interceptHandler = handler;
          return () => {};
        },
      ),
      navigate: vi.fn().mockImplementation(async () => {
        interceptHandler({
          url: '/i/api/graphql/abc/HomeLatestTimeline',
          status: 200,
          body: GRAPHQL_BODY,
        });
      }),
    });

    const result = await getFeed(primitives, { count: 0 });
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home');
    expect(result.items).toBeDefined();
  });

  it('returns items from intercepted GraphQL data', { timeout: 15000 }, async () => {
    const GRAPHQL_BODY = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              entries: [{
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '100',
                        legacy: {
                          id_str: '100',
                          full_text: 'Test tweet',
                          created_at: 'Mon Mar 18 23:49:31 +0000 2026',
                          favorite_count: 5,
                          retweet_count: 1,
                          reply_count: 0,
                        },
                        core: {
                          user_results: {
                            result: {
                              core: {
                                screen_name: 'testuser',
                                name: 'Test User',
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    });

    // Capture the intercept handler so we can trigger it on click (tab switch)
    let interceptHandler: any;
    const beforeTabSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'For you', selected: false },
    ]);
    const afterTabSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'For you', selected: true },
    ]);
    const primitives = createMockPrimitives({
      evaluate: vi.fn()
        .mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(beforeTabSwitch)   // URL ensure snapshot (returned to caller)
        .mockResolvedValueOnce(beforeTabSwitch)   // tab ensure initial check (selected: false -> click)
        .mockResolvedValueOnce(afterTabSwitch)    // tab ensure poll verification (selected: true)
        .mockResolvedValue(afterTabSwitch),       // any subsequent calls
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          interceptHandler = handler;
          return () => {};
        },
      ),
      // Simulate: tab click triggers Following GraphQL response
      click: vi.fn().mockImplementation(async () => {
        interceptHandler({
          url: '/i/api/graphql/abc/HomeLatestTimeline',
          status: 200,
          body: GRAPHQL_BODY,
        });
      }),
      // Simulate: navigate (reload fallback) also triggers GraphQL response
      navigate: vi.fn().mockImplementation(async () => {
        interceptHandler({
          url: '/i/api/graphql/abc/HomeLatestTimeline',
          status: 200,
          body: GRAPHQL_BODY,
        });
      }),
    });

    const result = await getFeed(primitives, { count: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe('Test tweet');
    expect(result.items[0].author.handle).toBe('testuser');
    expect(result.meta.coveredUsers).toContain('testuser');
  });

  it('MCP schema param names match GetFeedOptions', async () => {
    // Simulate the exact data flow: MCP schema parse → plugin.collect → getFeed
    const mcpInput = { count: 1, tab: 'following' as const };
    const parsed = TwitterFeedParamsSchema.parse(mcpInput);

    // getFeed receives the parsed object — check plugin-level params
    const opts = parsed as NonNullable<Parameters<typeof getFeed>[1]>;
    expect(opts.count).toBe(1);
    expect(opts.tab).toBe('following');
  });

  it('records trace spans when Trace is provided', { timeout: 15000 }, async () => {
    const { Trace } = await import('../../../trace.js');

    const GRAPHQL_BODY = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{ entries: [] }],
          },
        },
      },
    });

    let interceptHandler: any;
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          interceptHandler = handler;
          return () => {};
        },
      ),
      navigate: vi.fn().mockImplementation(async () => {
        interceptHandler({
          url: '/i/api/graphql/abc/HomeLatestTimeline',
          status: 200,
          body: GRAPHQL_BODY,
        });
      }),
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
    });

    const trace = new Trace('twitter_feed');
    const result = await getFeed(primitives, { count: 0 }, trace);

    // Result should NOT have debug field
    expect(result).not.toHaveProperty('debug');

    // Trace should have span data
    const traceData = trace.toJSON();
    expect(traceData.tool).toBe('twitter_feed');
    expect(traceData.status).toBe('ok');
    expect(traceData.root.children).toHaveLength(1); // getFeed root span

    const getFeedSpan = traceData.root.children[0];
    expect(getFeedSpan.name).toBe('getFeed');
    expect(getFeedSpan.status).toBe('ok');
    expect(getFeedSpan.attrs.tab).toBe('for_you');

    // Should have ensureTimeline and collectData child spans
    const childNames = getFeedSpan.children.map((c: any) => c.name);
    expect(childNames).toContain('ensureTimeline');
    expect(childNames).toContain('collectData');

    // ensureTimeline should have fine-grained children
    const ensureSpan = getFeedSpan.children.find((c: any) => c.name === 'ensureTimeline');
    expect(ensureSpan).toBeDefined();
    const ensureChildNames = ensureSpan!.children.map((c: any) => c.name);
    expect(ensureChildNames).toContain('navigate');
    expect(ensureChildNames).toContain('afterNavigate');
    expect(ensureChildNames).toContain('waitForData');
  });

});

describe('ensureTimeline', () => {
  it('navigates and waits for data when already on home', async () => {
    const collector = createDataCollector<any>();
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      navigate: vi.fn().mockImplementation(async () => {
        collector.push({ id: '1' });
      }),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'for_you',
      t0: Date.now(),
    });

    expect(result.navAction).toBe('already_there');
    expect(result.tabAction).toBe('already_there');
    expect(result.reloaded).toBe(false);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('switches tab and clears old data', async () => {
    const collector = createDataCollector<any>();
    collector.push({ id: 'old' });

    const afterTabSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: true },
    ]);
    const beforeTabSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: false },
    ]);

    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(beforeTabSwitch)   // URL ensure
        .mockResolvedValueOnce(beforeTabSwitch)   // tab ensure initial
        .mockResolvedValueOnce(afterTabSwitch)    // tab ensure after click
        .mockResolvedValue(afterTabSwitch),
      navigate: vi.fn().mockImplementation(async () => {
        collector.push({ id: 'wrong_tab' });
      }),
      click: vi.fn().mockImplementation(async () => {
        // Simulates: tab click triggers new GraphQL for correct tab
        collector.push({ id: 'correct_tab' });
      }),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
    });

    expect(result.tabAction).toBe('transitioned');
    // Old data and wrong-tab data should be cleared; only correct_tab data remains
    expect(collector.items.some((d: any) => d.id === 'old')).toBe(false);
    expect(collector.items.some((d: any) => d.id === 'correct_tab')).toBe(true);
  });

  it('reload fallback when tab switch produces no data', { timeout: 15000 }, async () => {
    const collector = createDataCollector<any>();

    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: false },
      { uid: '11', role: 'tab', name: 'For you', selected: true },
    ]);
    const afterSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: true },
    ]);

    let navigateCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(snapshot)      // URL ensure
        .mockResolvedValueOnce(snapshot)      // tab ensure initial (Following not selected)
        .mockResolvedValueOnce(afterSwitch)   // tab ensure after click
        // After reload fallback:
        .mockResolvedValueOnce(afterSwitch)   // tab ensure initial
        .mockResolvedValue(afterSwitch),      // subsequent
      navigate: vi.fn().mockImplementation(async () => {
        navigateCount++;
        // Only produce data on reload fallback (2nd navigate)
        if (navigateCount >= 2) {
          collector.push({ id: 'after_reload' });
        }
      }),
      click: vi.fn().mockResolvedValue(undefined),
      // Tab click does NOT produce data -> triggers reload fallback
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
    });

    expect(result.reloaded).toBe(true);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('does not reload twice', { timeout: 15000 }, async () => {
    const collector = createDataCollector<any>();

    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: false },
      { uid: '11', role: 'tab', name: 'For you', selected: true },
    ]);
    const afterSwitch = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '10', role: 'tab', name: 'Following', selected: true },
    ]);

    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValueOnce(afterSwitch)
        .mockResolvedValue(afterSwitch),
      navigate: vi.fn().mockResolvedValue(undefined),
      // Never produces data — navigate is a no-op
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
    });

    expect(result.reloaded).toBe(true);
    // navigate called: 1 (initial reload) + 1 (reload fallback) = 2
    // NOT 3 — no second reload fallback
    expect(primitives.navigate).toHaveBeenCalledTimes(2);
  });

  it('returns timing info in waits array', async () => {
    const collector = createDataCollector<any>();
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '1', role: 'link', name: 'Home' },
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      navigate: vi.fn().mockImplementation(async () => {
        collector.push({ id: '1' });
      }),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'for_you',
      t0: Date.now(),
    });

    expect(result.waits.length).toBeGreaterThan(0);
    expect(result.waits[0]).toMatchObject({
      purpose: expect.any(String),
      startedAt: expect.any(Number),
      resolvedAt: expect.any(Number),
      satisfied: true,
      dataCount: expect.any(Number),
    });
  });
});

describe('collectData', () => {
  it('returns immediately when data already >= count', async () => {
    const collector = createDataCollector<any>();
    collector.push({ id: '1' }, { id: '2' }, { id: '3' });

    const primitives = createMockPrimitives();
    const result = await collectData(primitives, collector, { count: 2, t0: Date.now() });

    expect(result.scrollRounds).toBe(0);
    expect(result.waits).toHaveLength(0);
    expect(primitives.scroll).not.toHaveBeenCalled();
  });

  it('scrolls and collects until count reached', async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        collector.push({ id: `scroll-${scrollCount}` });
      }),
    });

    const result = await collectData(primitives, collector, { count: 3, t0: Date.now() });

    expect(collector.length).toBeGreaterThanOrEqual(3);
    expect(result.scrollRounds).toBeGreaterThan(0);
  });

  it('exits after MAX_STALE_ROUNDS with no new data', { timeout: 15000 }, async () => {
    const collector = createDataCollector<any>();
    collector.push({ id: '1' });

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockResolvedValue(undefined),
    });

    const result = await collectData(primitives, collector, { count: 100, t0: Date.now() });

    expect(result.scrollRounds).toBe(3);
    expect(result.waits.every((w) => !w.satisfied)).toBe(true);
  });

  it('resets staleRounds when new data arrives', { timeout: 15000 }, async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        if (scrollCount === 1 || scrollCount === 3) {
          collector.push({ id: `s${scrollCount}` });
        }
      }),
    });

    const result = await collectData(primitives, collector, { count: 100, t0: Date.now() });

    expect(result.scrollRounds).toBe(6);
  });
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

describe('ensureTab', () => {
  it('returns already_there when target tab is selected', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('aria-selected')) return true;
        return undefined;
      }),
    });

    const result = await ensureTab(primitives, 'for_you');
    expect(result).toBe('already_there');
  });

  it('clicks tab and returns transitioned when not selected', async () => {
    let clickCalled = false;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('.click()')) {
          clickCalled = true;
          return undefined;
        }
        if (expr.includes('aria-selected')) {
          return clickCalled;
        }
        return undefined;
      }),
    });

    const result = await ensureTab(primitives, 'following');
    expect(result).toBe('transitioned');
    expect(clickCalled).toBe(true);
  });

  it('throws StateTransitionFailed when tab never becomes selected', { timeout: 10000 }, async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('aria-selected')) return false;
        return undefined;
      }),
    });

    await expect(ensureTab(primitives, 'following')).rejects.toThrow('not confirmed');
  });

  it('uses index 0 for for_you and index 1 for following', async () => {
    const expressions: string[] = [];
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        expressions.push(expr);
        if (expr.includes('aria-selected')) return true;
        return undefined;
      }),
    });

    await ensureTab(primitives, 'for_you');
    expect(expressions.some(e => e.includes('[0]'))).toBe(true);

    expressions.length = 0;
    await ensureTab(primitives, 'following');
    expect(expressions.some(e => e.includes('[1]'))).toBe(true);
  });
});

describe('getTweetDetail', () => {
  it('returns anchor as items[0] and replies as items[1..n]', { timeout: 15000 }, async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );

    let interceptHandler: ((response: { url: string; status: number; body: string }) => void) | null = null;

    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
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

  it('filters out ads from replies', { timeout: 15000 }, async () => {
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
