import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Primitives, SnapshotNode, Snapshot } from '../../../primitives/types.js';
import { TwitterFeedParamsSchema } from '../types.js';
import { createDataCollector } from '../../../ops/data-collector.js';
import type { RawTweetData } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fast timing for unit tests — eliminates real-timer waits */
const FAST_TIMING = {
  scrollWaitMs: 60,
  phase1PauseMinMs: 0,
  phase1PauseMaxMs: 0,
  bottomWaitMs: 10,
};

const FAST_WAIT_MS = 50;

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
    interceptRequestWithControl: vi.fn().mockResolvedValue({ cleanup: () => {}, reset: () => {}, hasPending: () => false }),
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

    let activeHandler: any;
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequestWithControl: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          activeHandler = handler;
          return {
            cleanup: vi.fn(),
            reset: vi.fn(),
            hasPending: vi.fn().mockReturnValue(false),
          };
        },
      ),
      navigate: vi.fn().mockImplementation(async () => {
        activeHandler({
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

    let activeHandler: any;
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
      interceptRequestWithControl: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          activeHandler = handler;
          return {
            cleanup: vi.fn(),
            reset: vi.fn(),
            hasPending: vi.fn().mockReturnValue(false),
          };
        },
      ),
      // Click triggers the target tab's GraphQL request.
      // Simulate R2 response arriving shortly after the click.
      click: vi.fn().mockImplementation(async () => {
        setTimeout(() => activeHandler(graphqlResponse), 10);
      }),
      navigate: vi.fn().mockImplementation(async () => {
        activeHandler(graphqlResponse);
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

    let activeHandler: any;
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequestWithControl: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          activeHandler = handler;
          return {
            cleanup: vi.fn(),
            reset: vi.fn(),
            hasPending: vi.fn().mockReturnValue(false),
          };
        },
      ),
      navigate: vi.fn().mockImplementation(async () => {
        activeHandler({
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

describe('getFeed — narrow interceptor pattern (#13)', () => {
  // Minimal GraphQL body that parseGraphQLTimeline can handle
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
                      rest_id: '200',
                      legacy: {
                        id_str: '200',
                        full_text: 'Narrow test tweet',
                        created_at: 'Mon Mar 18 23:49:31 +0000 2026',
                        favorite_count: 1,
                        retweet_count: 0,
                        reply_count: 0,
                      },
                      core: {
                        user_results: {
                          result: {
                            core: { screen_name: 'narrowuser', name: 'Narrow User' },
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

  /**
   * Method A mock: interceptRequestWithControl that actually checks URL against
   * the pattern before calling the handler. This exercises the narrow regex.
   */
  function makeFilteringIntercept() {
    let activeHandler: ((resp: { url: string; status: number; body: string }) => void) | null = null;
    let activePattern: RegExp | null = null;
    const cleanup = vi.fn();
    const reset = vi.fn();
    const hasPending = vi.fn().mockReturnValue(false);

    const interceptFn = vi.fn().mockImplementation(
      async (pattern: RegExp, handler: (resp: { url: string; status: number; body: string }) => void) => {
        activePattern = pattern;
        activeHandler = handler;
        return { cleanup, reset, hasPending };
      },
    );

    /** Emit a response — only calls handler if URL matches the registered pattern */
    function emit(url: string, body: string) {
      if (activePattern && activePattern.test(url) && activeHandler) {
        activeHandler({ url, status: 200, body });
      }
    }

    return { interceptFn, emit, cleanup, reset, hasPending };
  }

  it('B1: following + already on tab — data preserved, no reload or scroll', { timeout: 15000 }, async () => {
    const { interceptFn, emit } = makeFilteringIntercept();

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'Following' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '11', role: 'tab', name: 'Following', selected: true },
        ]),
      ),
      interceptRequestWithControl: interceptFn,
      navigate: vi.fn().mockImplementation(async () => {
        // Twitter fires both endpoints on navigate(home)
        emit('/i/api/graphql/abc/HomeTimeline?variables=xyz', GRAPHQL_BODY);
        emit('/i/api/graphql/abc/HomeLatestTimeline?variables=xyz', GRAPHQL_BODY);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'following', debug: false });

    // Data should be preserved — no reload needed
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(primitives.navigate).toHaveBeenCalledTimes(1); // no reload
    expect(primitives.scroll).not.toHaveBeenCalled();
  });

  it('B2: for_you + already on tab — data preserved', { timeout: 15000 }, async () => {
    const { interceptFn, emit } = makeFilteringIntercept();

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequestWithControl: interceptFn,
      navigate: vi.fn().mockImplementation(async () => {
        emit('/i/api/graphql/abc/HomeTimeline?variables=xyz', GRAPHQL_BODY);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'for_you', debug: false });

    expect(result.items.length).toBe(1);
    expect(primitives.navigate).toHaveBeenCalledTimes(1);
  });

  it('B3: community — navigate HomeTimeline ignored, tab click data captured', { timeout: 15000 }, async () => {
    const { interceptFn, emit } = makeFilteringIntercept();
    const communityTabs = JSON.stringify([
      { name: 'For you', index: 0 },
      { name: 'Following', index: 1 },
      { name: 'Life AI Community', index: 2 },
    ]);

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({
        'querySelectorAll': communityTabs,
        'textContent': 'Life AI Community',
      }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '20', role: 'tab', name: 'Life AI Community', selected: false },
        ]))
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '20', role: 'tab', name: 'Life AI Community', selected: false },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '20', role: 'tab', name: 'Life AI Community', selected: true },
        ])),
      interceptRequestWithControl: interceptFn,
      navigate: vi.fn().mockImplementation(async () => {
        // navigate fires HomeTimeline (should be ignored by community pattern)
        emit('/i/api/graphql/abc/HomeTimeline?variables=xyz', GRAPHQL_BODY);
      }),
      click: vi.fn().mockImplementation(async () => {
        // tab click fires CommunityTweetsTimeline
        setTimeout(() => emit('/i/api/graphql/abc/CommunityTweetsTimeline?variables=xyz', GRAPHQL_BODY), 10);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'Life AI Community', debug: false });
    expect(result.items.length).toBe(1);
  });

  it('B4: for_you → following — HomeTimeline ignored, tab click HomeLatestTimeline captured', { timeout: 15000 }, async () => {
    const { interceptFn, emit } = makeFilteringIntercept();

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
      interceptRequestWithControl: interceptFn,
      navigate: vi.fn().mockImplementation(async () => {
        // navigate fires HomeTimeline (for_you) — not matching following's pattern
        emit('/i/api/graphql/abc/HomeTimeline?variables=xyz', GRAPHQL_BODY);
      }),
      click: vi.fn().mockImplementation(async () => {
        // tab click fires HomeLatestTimeline
        setTimeout(() => emit('/i/api/graphql/abc/HomeLatestTimeline?variables=xyz', GRAPHQL_BODY), 10);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'following', debug: false });
    expect(result.items.length).toBe(1);
  });

  it('B7: for_you + navigate fires both endpoints — only HomeTimeline captured', { timeout: 15000 }, async () => {
    const { interceptFn, emit } = makeFilteringIntercept();

    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'textContent': 'For you' }),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([
          { uid: '10', role: 'tab', name: 'For you', selected: true },
        ]),
      ),
      interceptRequestWithControl: interceptFn,
      navigate: vi.fn().mockImplementation(async () => {
        // Both endpoints fire; only HomeTimeline should match for_you
        emit('/i/api/graphql/abc/HomeTimeline?variables=xyz', GRAPHQL_BODY);
        emit('/i/api/graphql/abc/HomeLatestTimeline?variables=xyz', GRAPHQL_BODY);
      }),
    });

    const result = await getFeed(primitives, { count: 1, tab: 'for_you', debug: false });
    // Only 1 item from the single matching response (HomeTimeline)
    expect(result.items.length).toBe(1);
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
      waitMs: FAST_WAIT_MS,
    });

    expect(result.navAction).toBe('already_there');
    expect(result.tabAction).toBe('already_there');
    expect(result.reloaded).toBe(false);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('switches tab and collects data from click', async () => {
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
      // Click triggers the target tab's GraphQL request.
      // Simulate R2 response arriving shortly after the click.
      click: vi.fn().mockImplementation(async () => {
        setTimeout(() => collector.push({ id: 'correct_tab' }), 10);
      }),
    });

    const result = await ensureTimeline(primitives, collector, {
      tab: 'following',
      t0: Date.now(),
      waitMs: FAST_WAIT_MS,
    });

    expect(result.tabAction).toBe('transitioned');
    expect(collector.items.some((d: any) => d.id === 'correct_tab')).toBe(true);
  });

  it('reload fallback when tab switch produces no data', { timeout: 5000 }, async () => {
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
      waitMs: FAST_WAIT_MS,
    });

    expect(result.reloaded).toBe(true);
    expect(collector.length).toBeGreaterThan(0);
  });

  it('does not reload twice', { timeout: 5000 }, async () => {
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
      waitMs: FAST_WAIT_MS,
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
      waitMs: FAST_WAIT_MS,
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
    const result = await collectData(primitives, collector, {
      count: 2, t0: Date.now(),
      hasInflightRequest: () => false,
      timing: FAST_TIMING,
    });

    expect(result.scrollRounds).toBe(0);
    expect(primitives.scroll).not.toHaveBeenCalled();
  });

  it('scrolls and collects until count reached', async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;
    let pendingRequest = false;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        pendingRequest = true;
        setTimeout(() => {
          pendingRequest = false;
          collector.push({ id: `scroll-${scrollCount}` });
        }, 50);
      }),
      evaluate: vi.fn().mockResolvedValue(false), // not at bottom
    });

    const result = await collectData(primitives, collector, {
      count: 3, t0: Date.now(),
      hasInflightRequest: () => pendingRequest,
      timing: FAST_TIMING,
    });

    expect(collector.length).toBeGreaterThanOrEqual(3);
    expect(result.scrollRounds).toBeGreaterThan(0);
  });

  it('exits after MAX_STALE_ROUNDS with no new data at bottom', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();
    collector.push({ id: '1' });

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(true), // at bottom
    });

    const result = await collectData(primitives, collector, {
      count: 100, t0: Date.now(),
      hasInflightRequest: () => false,
      timing: FAST_TIMING,
    });

    // Phase 1 exits immediately (atBottom), stale check runs 3 times
    expect(result.scrollRounds).toBe(0);
  });

  it('exits after MAX_PHASE1_SCROLLS * MAX_FAILED_ROUNDS when no request fires', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(false), // never at bottom
    });

    const result = await collectData(primitives, collector, {
      count: 100, t0: Date.now(),
      hasInflightRequest: () => false,
      timing: FAST_TIMING,
    });

    // Phase 1 scrolls 20 times (MAX_PHASE1_SCROLLS), no request -> Phase 2 timeout
    // failedRounds=1, forceScroll -> Phase 1 scrolls 20 more -> Phase 2 timeout
    // failedRounds=2 -> Phase 1 scrolls 20 more -> Phase 2 timeout
    // failedRounds=3 = MAX_FAILED_ROUNDS -> break
    expect(result.scrollRounds).toBe(60);
  });

  it('recovers via forceScroll after Phase 2 timeout', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;
    let pendingRequest = false;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        // First batch: no request fires for 20 scrolls -> Phase 2 timeout
        // Second batch: request fires on scroll 25, data arrives
        if (scrollCount === 25) {
          pendingRequest = true;
          setTimeout(() => {
            pendingRequest = false;
            for (let i = 0; i < 100; i++) {
              collector.push({ id: `item-${i}` });
            }
          }, 50);
        }
      }),
      evaluate: vi.fn().mockResolvedValue(false), // never at bottom
    });

    const result = await collectData(primitives, collector, {
      count: 50, t0: Date.now(),
      hasInflightRequest: () => pendingRequest,
      timing: FAST_TIMING,
    });

    expect(collector.length).toBeGreaterThanOrEqual(50);
    expect(result.scrollRounds).toBe(25);
  });

  it('continues scrolling when inflight request never resolves (forceScroll)', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;
    let stuckRequest = false;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        if (scrollCount === 3) stuckRequest = true;
      }),
      evaluate: vi.fn().mockImplementation(async () => {
        return scrollCount >= 10;
      }),
    });

    const result = await collectData(primitives, collector, {
      count: 100, t0: Date.now(),
      hasInflightRequest: () => stuckRequest,
      timing: FAST_TIMING,
    });

    expect(result.scrollRounds).toBeGreaterThan(0);
  });

  it('exits cleanly when responses contain no data', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;
    let pendingRequest = false;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        if (scrollCount % 3 === 0) {
          pendingRequest = true;
          setTimeout(() => {
            pendingRequest = false;
            // Push nothing — empty response
          }, 50);
        }
      }),
      evaluate: vi.fn().mockImplementation(async () => scrollCount >= 12),
    });

    const result = await collectData(primitives, collector, {
      count: 50, t0: Date.now(),
      hasInflightRequest: () => pendingRequest,
      timing: FAST_TIMING,
    });

    expect(collector.length).toBe(0);
    expect(result.scrollRounds).toBeGreaterThan(0);
  });

  it('handles multiple inflight requests naturally', { timeout: 5000 }, async () => {
    const collector = createDataCollector<any>();
    let scrollCount = 0;
    let pendingRequests = 0;

    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        if (scrollCount <= 2) {
          pendingRequests++;
          const idx = scrollCount;
          setTimeout(() => {
            pendingRequests--;
            collector.push(
              ...Array.from({ length: 25 }, (_, i) => ({ id: `batch${idx}-${i}` })),
            );
          }, 50 * idx);
        }
      }),
      evaluate: vi.fn().mockResolvedValue(false),
    });

    const result = await collectData(primitives, collector, {
      count: 50, t0: Date.now(),
      hasInflightRequest: () => pendingRequests > 0,
      timing: FAST_TIMING,
    });

    expect(collector.length).toBeGreaterThanOrEqual(50);
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
      waitMs: FAST_WAIT_MS,
    });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/author/status/100');
    expect(result.reloaded).toBe(false);
    expect(collector.length).toBe(1);
  });

  it('reloads when no data arrives within timeout', { timeout: 5000 }, async () => {
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
      waitMs: FAST_WAIT_MS,
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
        waitMs: FAST_WAIT_MS,
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
      interceptRequestWithControl: vi.fn().mockImplementation(async (_pattern: any, handler: any) => {
        interceptHandler = handler;
        return { cleanup: vi.fn(), reset: vi.fn(), hasPending: vi.fn().mockReturnValue(false) };
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

  it('returns ancestors when viewing a reply tweet', { timeout: 15000 }, async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/golden/tweet-detail-with-ancestors.json'), 'utf-8',
    );

    let interceptHandler: ((response: { url: string; status: number; body: string }) => void) | null = null;

    const primitives = createMockPrimitives({
      interceptRequestWithControl: vi.fn().mockImplementation(async (_pattern: any, handler: any) => {
        interceptHandler = handler;
        return { cleanup: vi.fn(), reset: vi.fn(), hasPending: vi.fn().mockReturnValue(false) };
      }),
      navigate: vi.fn().mockImplementation(async () => {
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
      evaluate: vi.fn().mockResolvedValue('https://x.com/suvendu2805/status/2043242212197323042'),
    });

    const result = await getTweetDetail(primitives, {
      url: 'https://x.com/suvendu2805/status/2043242212197323042',
      count: 20,
    });

    // items[0] is the target tweet (anchor)
    expect(result.items[0].author.handle).toBe('suvendu2805');

    // ancestors present, oldest first
    expect(result.ancestors).toBeDefined();
    expect(result.ancestors!).toHaveLength(2);
    expect(result.ancestors![0].author.handle).toBe('narendramodi');
    expect(result.ancestors![1].author.handle).toBe('Sultan_analysis');
  });

  it('omits ancestors field for non-reply tweets', { timeout: 15000 }, async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );

    let interceptHandler: ((response: { url: string; status: number; body: string }) => void) | null = null;

    const primitives = createMockPrimitives({
      interceptRequestWithControl: vi.fn().mockImplementation(async (_pattern: any, handler: any) => {
        interceptHandler = handler;
        return { cleanup: vi.fn(), reset: vi.fn(), hasPending: vi.fn().mockReturnValue(false) };
      }),
      navigate: vi.fn().mockImplementation(async () => {
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

    // No ancestors for a non-reply tweet
    expect(result.ancestors).toBeUndefined();
  });

  it('filters out ads from replies', { timeout: 15000 }, async () => {
    const fixtureBody = fs.readFileSync(
      path.join(__dirname, 'fixtures/tweet-detail-initial.json'), 'utf-8',
    );

    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      interceptRequestWithControl: vi.fn().mockImplementation(async (_p: any, handler: any) => {
        interceptHandler = handler;
        return { cleanup: vi.fn(), reset: vi.fn(), hasPending: vi.fn().mockReturnValue(false) };
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
