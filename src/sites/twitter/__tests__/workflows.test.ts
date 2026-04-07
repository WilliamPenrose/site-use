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

/**
 * Build an evaluate mock that routes by expression content.
 * @param overrides - keyed by substring match on the expression
 */
function mockEvaluate(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'location.href': 'https://x.com/home',
    'AppTabBar_Home_Link': true,
    'querySelectorAll': JSON.stringify([{ name: 'For you', index: 0 }, { name: 'Following', index: 1 }]),
    'textContent': 'MockTab',
  };
  const merged = { ...defaults, ...overrides };

  return vi.fn().mockImplementation(async (expr: string) => {
    for (const [key, value] of Object.entries(merged)) {
      if (expr.includes(key)) {
        return typeof value === 'function' ? (value as Function)() : value;
      }
    }
    return undefined;
  });
}

let checkLogin: typeof import('../workflows.js').checkLogin;
let getFeed: typeof import('../workflows.js').getFeed;
let ensureTimeline: typeof import('../workflows.js').ensureTimeline;
let collectData: typeof import('../workflows.js').collectData;
let ensureTweetDetail: typeof import('../workflows.js').ensureTweetDetail;
let getTweetDetail: typeof import('../workflows.js').getTweetDetail;

beforeEach(async () => {
  const mod = await import('../workflows.js');
  checkLogin = mod.checkLogin;
  getFeed = mod.getFeed;
  ensureTimeline = mod.ensureTimeline;
  collectData = mod.collectData;
  ensureTweetDetail = mod.ensureTweetDetail;
  getTweetDetail = mod.getTweetDetail;
});

describe('checkLogin', () => {
  it('returns loggedIn: false when URL redirects to login', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({
        'location.href': 'https://x.com/i/flow/login',
        'AppTabBar_Home_Link': false,
      }),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(false);
  });

  it('returns loggedIn: true when Home link found via data-testid', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'AppTabBar_Home_Link': true }),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(true);
  });

  it('returns loggedIn: false when no Home link found', { timeout: 15000 }, async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'AppTabBar_Home_Link': false }),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(false);
  });

  it('navigates to x.com/home', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'AppTabBar_Home_Link': true }),
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
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
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

    const result = await getFeed(primitives, { count: 0, tab: 'for_you', debug: false });
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home');
    expect(result.items).toBeDefined();
  });

  it('returns items from intercepted GraphQL data', { timeout: 15000 }, async () => {
    const GRAPHQL_BODY = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{
              type: 'TimelineAddEntries',
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

    let interceptHandler: any;
    let interceptCallCount = 0;
    const graphqlResponse = { url: '/i/api/graphql/abc/HomeLatestTimeline', status: 200, body: GRAPHQL_BODY };
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: false },
        ]))
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: false },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ])),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          interceptHandler = handler;
          interceptCallCount++;
          // On re-registration (2nd+ call), simulate the target tab's GraphQL
          // response arriving shortly after the new handler is installed.
          // With the new switchTab order (ensureTabNav before reRegisterInterceptor),
          // the click triggers the request, and the new handler catches the response.
          if (interceptCallCount > 1) {
            setTimeout(() => handler(graphqlResponse), 10);
          }
          return () => {};
        },
      ),
      // Click triggers the GraphQL request but old handler is still active;
      // data pushed here uses the old generation and gets cleared on re-register.
      click: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockImplementation(async () => {
        interceptHandler(graphqlResponse);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'for_you', debug: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe('Test tweet');
    expect(result.items[0].author.handle).toBe('testuser');
    expect(result.meta.coveredUsers).toContain('testuser');
  });

  it('MCP schema params can be used as getFeed options', async () => {
    const mcpInput = { count: 1, tab: 'following' };
    const parsed = TwitterFeedParamsSchema.parse(mcpInput);
    expect(parsed.count).toBe(1);
    expect(parsed.tab).toBe('following');
    const customTab = TwitterFeedParamsSchema.parse({ tab: 'vibe coding' });
    expect(customTab.tab).toBe('vibe coding');
  });

  it('records trace spans when Trace is provided', { timeout: 30000 }, async () => {
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
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
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

    const trace = new Trace('twitter_feed');
    const result = await getFeed(primitives, { count: 0, tab: 'for_you', debug: false }, trace);

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
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
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
      reRegisterInterceptor: vi.fn(),
    });

    expect(result.navAction).toBe('already_there');
    expect(result.tabAction).toBe('already_there');
    expect(result.reloaded).toBe(false);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('switches tab and clears old data', async () => {
    const collector = createDataCollector<any>();
    collector.push({ id: 'old' });

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'Following' }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: true },
        ])),
      navigate: vi.fn().mockImplementation(async () => {
        collector.push({ id: 'wrong_tab' });
      }),
      // Click triggers the GraphQL request but old handler is still active,
      // so we don't push data here — the new handler (after re-register) will catch it.
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
      // New order: ensureTabNav (click) runs first, then reRegisterInterceptor.
      // The re-register clears old data and the new handler receives the target tab's response.
      reRegisterInterceptor: vi.fn().mockImplementation(async () => {
        collector.clear();
        collector.push({ id: 'correct_tab' });
      }),
    });

    expect(result.tabAction).toBe('transitioned');
    expect(collector.items.some((d: any) => d.id === 'old')).toBe(false);
    expect(collector.items.some((d: any) => d.id === 'correct_tab')).toBe(true);
  });

  it('reload fallback when tab switch produces no data', { timeout: 15000 }, async () => {
    const collector = createDataCollector<any>();

    let navigateCount = 0;
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'Following' }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: true },
        ])),
      navigate: vi.fn().mockImplementation(async () => {
        navigateCount++;
        if (navigateCount >= 2) {
          collector.push({ id: 'after_reload' });
        }
      }),
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
      reRegisterInterceptor: vi.fn(),
    });

    expect(result.reloaded).toBe(true);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('does not reload twice', { timeout: 30000 }, async () => {
    const collector = createDataCollector<any>();

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'Following' }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: false },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: true },
        ])),
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
      reRegisterInterceptor: vi.fn(),
    });

    expect(result.reloaded).toBe(true);
    expect(primitives.navigate).toHaveBeenCalledTimes(2);
  });

  it('returns timing info in waits array', async () => {
    const collector = createDataCollector<any>();
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
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
      reRegisterInterceptor: vi.fn(),
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
