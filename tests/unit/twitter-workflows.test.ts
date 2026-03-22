import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Primitives, SnapshotNode, Snapshot } from '../../src/primitives/types.js';
import { SessionExpired } from '../../src/errors.js';

function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
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

let checkLogin: typeof import('../../src/sites/twitter/workflows.js').checkLogin;
let requireLogin: typeof import('../../src/sites/twitter/workflows.js').requireLogin;
let getTimeline: typeof import('../../src/sites/twitter/workflows.js').getTimeline;

beforeEach(async () => {
  const mod = await import('../../src/sites/twitter/workflows.js');
  checkLogin = mod.checkLogin;
  requireLogin = mod.requireLogin;
  getTimeline = mod.getTimeline;
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
        buildSnapshot([{ uid: '1', role: 'link', name: 'Home' }]),
      ),
    });
    const result = await checkLogin(primitives);
    expect(result.loggedIn).toBe(true);
  });

  it('returns loggedIn: false when no Home link in snapshot', async () => {
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
        buildSnapshot([{ uid: '1', role: 'link', name: 'Home' }]),
      ),
    });
    await checkLogin(primitives);
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home', 'twitter');
  });
});

describe('requireLogin', () => {
  it('resolves when logged in', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([{ uid: '1', role: 'link', name: 'Home' }]),
      ),
    });
    await expect(requireLogin(primitives)).resolves.toBeUndefined();
  });

  it('throws SessionExpired when not logged in', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/i/flow/login'),
    });
    await expect(requireLogin(primitives)).rejects.toThrow(SessionExpired);
  });
});

describe('getTimeline', () => {
  it('navigates to x.com/home directly (auth guard handles login check)', async () => {
    const GRAPHQL_BODY = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [{ entries: [] }],
          },
        },
      },
    });

    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([{ uid: '1', role: 'link', name: 'Home' }]),
      ),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          handler({
            url: '/i/api/graphql/abc/HomeLatestTimeline',
            status: 200,
            body: GRAPHQL_BODY,
          });
          return () => {};
        },
      ),
    });

    const result = await getTimeline(primitives, 0);
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home', 'twitter');
    expect(result.tweets).toBeDefined();
  });

  it('returns tweets from intercepted GraphQL data', async () => {
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
                              legacy: {
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

    const primitives = createMockPrimitives({
      // checkLogin calls evaluate once for URL check
      evaluate: vi.fn()
        .mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot([{ uid: '1', role: 'link', name: 'Home' }]),
      ),
      interceptRequest: vi.fn().mockImplementation(
        async (_pattern: any, handler: any) => {
          // Simulate GraphQL response arriving during interception setup
          handler({
            url: '/i/api/graphql/abc/HomeLatestTimeline',
            status: 200,
            body: GRAPHQL_BODY,
          });
          return () => {};
        },
      ),
    });

    const result = await getTimeline(primitives, 1);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets[0].text).toBe('Test tweet');
    expect(result.tweets[0].author.handle).toBe('testuser');
    expect(result.meta.tweetCount).toBe(1);
  });
});
