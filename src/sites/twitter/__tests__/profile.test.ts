import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Primitives } from '../../../primitives/types.js';
import type { ProfileResult, ProfileWithTimelineResult, FollowListResult } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/profile-sample.json'), 'utf-8',
);
const goldenFollowingBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/following-sample.json'), 'utf-8',
);
const userTweetsBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/user-tweets-sample.json'), 'utf-8',
);
const userTweetsAndRepliesBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/user-tweets-and-replies-sample.json'), 'utf-8',
);

function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    takeSnapshot: vi.fn().mockResolvedValue({ idToNode: new Map() }),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    scrollIntoView: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue('base64png'),
    interceptRequest: vi.fn().mockResolvedValue(() => {}),
    interceptRequestWithControl: vi.fn().mockResolvedValue({ cleanup: () => {}, reset: () => {}, hasPending: () => false }),
    getRawPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('getProfile', () => {
  it('returns profile with relationship for a valid handle', async () => {
    let interceptHandler: ((response: { url: string; status: number; body: string }) => void) | null = null;

    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        // Simulate GraphQL response arriving after navigation
        if (interceptHandler) {
          interceptHandler({
            url: '/i/api/graphql/abc/UserByScreenName?variables=...',
            status: 200,
            body: goldenBody,
          });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => { interceptHandler = null; };
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')  // checkLoginRedirect: location.href
        .mockResolvedValueOnce(null)                       // checkProfileError: no error
        .mockResolvedValueOnce(null),                      // self-handle detection: not self
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng' }) as ProfileResult;

    expect(result.user.handle).toBe('hwwaanng');
    expect(result.user.displayName).toBe('Hwang');
    expect(result.user.followersCount).toBe(20458);
    expect(result.relationship).not.toBeNull();
    expect(result.relationship!.youFollowThem).toBe(false);
  });

  it('resolves handle from URL', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/UserByScreenName', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { url: 'https://x.com/hwwaanng' }) as ProfileResult;

    expect(result.user.handle).toBe('hwwaanng');
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/hwwaanng');
  });

  it('throws when neither handle nor url provided', async () => {
    const primitives = createMockPrimitives();
    const { getProfile } = await import('../profile.js');
    await expect(getProfile(primitives, {})).rejects.toThrow('Either handle or url is required');
  });

  it('throws SessionExpired when redirected to login', async () => {
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/i/flow/login'),
    });
    const { getProfile } = await import('../profile.js');
    await expect(getProfile(primitives, { handle: 'test' })).rejects.toThrow('Not logged in');
  });

  it('throws UserNotFound for nonexistent user', async () => {
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/nonexistent')
        .mockResolvedValueOnce('emptyState'),
    });
    const { getProfile } = await import('../profile.js');
    await expect(getProfile(primitives, { handle: 'nonexistent' })).rejects.toThrow('does not exist');
  });

  it('throws Blocked when user has blocked you', async () => {
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/blocker')
        .mockResolvedValueOnce('blocked'),
    });
    const { getProfile } = await import('../profile.js');
    await expect(getProfile(primitives, { handle: 'blocker' })).rejects.toThrow('blocked');
  });

  it('throws ElementNotFound when GraphQL response times out', async () => {
    vi.useFakeTimers();
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/slowuser')
        .mockResolvedValue(null),
    });
    const { getProfile } = await import('../profile.js');
    const promise = getProfile(primitives, { handle: 'slowuser' });
    // Attach rejection handler before advancing timers to avoid unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow('No UserByScreenName response received');
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
    vi.useRealTimers();
  });

  it('returns null relationship for self-profile', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/UserByScreenName', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('hwwaanng'),
    });
    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng' }) as ProfileResult;
    expect(result.user.handle).toBe('hwwaanng');
    expect(result.relationship).toBeNull();
  });
});

describe('getProfile — follow list dispatch', () => {
  it('dispatches to follow list when --following is set', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Following', status: 200, body: goldenFollowingBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        if (pattern.source.includes('Following|Followers')) interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/halo80238964/following')
        .mockResolvedValueOnce(null),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'halo80238964', following: true, count: 5 }) as FollowListResult;

    // Should return FollowListResult, not ProfileResult
    expect(result.users.length).toBeGreaterThan(0);
    expect(result.meta.owner).toBe('halo80238964');
  });

  it('dispatches to follow list when --followers is set', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Followers', status: 200, body: goldenFollowingBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        if (pattern.source.includes('Following|Followers')) interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/test/followers')
        .mockResolvedValueOnce(null),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'test', followers: true, count: 5 }) as FollowListResult;

    expect(result.users).toBeDefined();
  });

  it('still returns ProfileResult when no list flags', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/UserByScreenName', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng' }) as ProfileResult;

    expect(result.user).toBeDefined();
    expect(result.relationship).toBeDefined();
  });
});

describe('getProfile — timeline dispatch', () => {
  it('returns posts when --posts is set', async () => {
    // Track intercepted patterns and their handlers
    const handlers = new Map<string, (response: { url: string; status: number; body: string }) => void>();

    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        // Navigation triggers both UserByScreenName and UserTweets responses
        const profileHandler = handlers.get('profile');
        if (profileHandler) {
          profileHandler({
            url: '/i/api/graphql/abc/UserByScreenName?variables=...',
            status: 200,
            body: goldenBody,
          });
        }
        const tweetsHandler = handlers.get('tweets');
        if (tweetsHandler) {
          tweetsHandler({
            url: '/i/api/graphql/xyz/UserTweets?variables=...',
            status: 200,
            body: userTweetsBody,
          });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        if (pattern.source.includes('UserByScreenName')) {
          handlers.set('profile', handler);
        } else if (pattern.source.includes('UserTweets')) {
          handlers.set('tweets', handler);
        }
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')  // checkLoginRedirect
        .mockResolvedValueOnce(null)                       // checkProfileError
        .mockResolvedValueOnce(null),                      // getSelfHandle
      scroll: vi.fn().mockResolvedValue(undefined),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng', posts: true, count: 5 }) as ProfileWithTimelineResult;

    expect(result.user.handle).toBe('hwwaanng');
    expect(result.posts).toBeDefined();
    expect(result.posts!.length).toBeLessThanOrEqual(5);
    expect(result.posts!.length).toBeGreaterThan(0);
    // Each post is a FeedItem with expected structure
    for (const post of result.posts!) {
      expect(post.id).toBeDefined();
      expect(post.author).toBeDefined();
      expect(post.text).toBeDefined();
      expect(post.siteMeta).toBeDefined();
    }
  });

  it('returns replies filtered to target user with inReplyTo.text', async () => {
    const handlers = new Map<string, (response: { url: string; status: number; body: string }) => void>();

    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        // Navigation triggers profile response
        const profileHandler = handlers.get('profile');
        if (profileHandler) {
          profileHandler({
            url: '/i/api/graphql/abc/UserByScreenName?variables=...',
            status: 200,
            body: goldenBody,
          });
        }
        // Also triggers UserTweets (even if we only want replies, the intercept is set up)
        const tweetsHandler = handlers.get('tweets');
        if (tweetsHandler) {
          tweetsHandler({
            url: '/i/api/graphql/xyz/UserTweets?variables=...',
            status: 200,
            body: userTweetsBody,
          });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        if (pattern.source.includes('UserByScreenName')) {
          handlers.set('profile', handler);
        } else if (pattern.source.includes('UserTweetsAndReplies')) {
          handlers.set('replies', handler);
        } else if (pattern.source.includes('UserTweets')) {
          handlers.set('tweets', handler);
        }
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')  // checkLoginRedirect
        .mockResolvedValueOnce(null)                       // checkProfileError
        .mockResolvedValueOnce(null)                       // getSelfHandle
        // DOM-to-ARIA bridge: evaluate returns tab text for replies tab
        .mockResolvedValueOnce('返信'),                     // find replies tab by href
      takeSnapshot: vi.fn().mockResolvedValue({
        idToNode: new Map([
          ['tab-1', { uid: 'tab-1', role: 'tab', name: '返信' }],
        ]),
      }),
      click: vi.fn().mockImplementation(async () => {
        // Clicking the replies tab triggers UserTweetsAndReplies
        const repliesHandler = handlers.get('replies');
        if (repliesHandler) {
          repliesHandler({
            url: '/i/api/graphql/yyy/UserTweetsAndReplies?variables=...',
            status: 200,
            body: userTweetsAndRepliesBody,
          });
        }
      }),
      scroll: vi.fn().mockResolvedValue(undefined),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng', replies: true, count: 5 }) as ProfileWithTimelineResult;

    expect(result.user.handle).toBe('hwwaanng');
    expect(result.replies).toBeDefined();
    expect(result.replies!.length).toBeGreaterThan(0);
    expect(result.replies!.length).toBeLessThanOrEqual(5);

    // All replies should be by the target user with inReplyTo at top level
    for (const reply of result.replies!) {
      expect(reply.author.handle.toLowerCase()).toBe('hwwaanng');
      expect(reply.inReplyTo).toBeDefined();
      expect(reply.inReplyTo!.id).toBeTruthy();     // generic field name (not tweetId)
      expect(reply.inReplyTo!.handle).toBeTruthy();
    }

    // At least one reply should have inReplyTo.text enriched from the tweet map
    const withText = result.replies!.filter(r => r.inReplyTo?.text);
    expect(withText.length).toBeGreaterThan(0);
  });

  it('handles partial failure — posts succeed, replies fail', async () => {
    const handlers = new Map<string, (response: { url: string; status: number; body: string }) => void>();

    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        const profileHandler = handlers.get('profile');
        if (profileHandler) {
          profileHandler({
            url: '/i/api/graphql/abc/UserByScreenName?variables=...',
            status: 200,
            body: goldenBody,
          });
        }
        const tweetsHandler = handlers.get('tweets');
        if (tweetsHandler) {
          tweetsHandler({
            url: '/i/api/graphql/xyz/UserTweets?variables=...',
            status: 200,
            body: userTweetsBody,
          });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        if (pattern.source.includes('UserByScreenName')) {
          handlers.set('profile', handler);
        } else if (pattern.source.includes('UserTweetsAndReplies')) {
          handlers.set('replies', handler);
        } else if (pattern.source.includes('UserTweets')) {
          handlers.set('tweets', handler);
        }
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')  // checkLoginRedirect
        .mockResolvedValueOnce(null)                       // checkProfileError
        .mockResolvedValueOnce(null)                       // getSelfHandle
        // DOM-to-ARIA bridge: evaluate returns null (tab not found)
        .mockResolvedValueOnce(null),
      scroll: vi.fn().mockResolvedValue(undefined),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng', posts: true, replies: true, count: 5 }) as ProfileWithTimelineResult;

    // Posts should succeed
    expect(result.posts).toBeDefined();
    expect(result.posts!.length).toBeGreaterThan(0);

    // Replies should be undefined (failed)
    expect(result.replies).toBeUndefined();

    // Errors should contain a message about replies
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toMatch(/replies/i);
  });

  it('--replies alone does not register UserTweets interceptor', async () => {
    const interceptedPatterns: string[] = [];
    const handlers = new Map<string, (response: { url: string; status: number; body: string }) => void>();

    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        const profileHandler = handlers.get('profile');
        if (profileHandler) {
          profileHandler({
            url: '/i/api/graphql/abc/UserByScreenName?variables=...',
            status: 200,
            body: goldenBody,
          });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (pattern: RegExp, handler: any) => {
        interceptedPatterns.push(pattern.source);
        if (pattern.source.includes('UserByScreenName')) {
          handlers.set('profile', handler);
        } else if (pattern.source.includes('UserTweetsAndReplies')) {
          handlers.set('replies', handler);
        }
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/hwwaanng')  // checkLoginRedirect
        .mockResolvedValueOnce(null)                       // checkProfileError
        .mockResolvedValueOnce(null)                       // getSelfHandle
        .mockResolvedValueOnce('返信'),                     // find replies tab by href
      takeSnapshot: vi.fn().mockResolvedValue({
        idToNode: new Map([
          ['tab-1', { uid: 'tab-1', role: 'tab', name: '返信' }],
        ]),
      }),
      click: vi.fn().mockImplementation(async () => {
        const repliesHandler = handlers.get('replies');
        if (repliesHandler) {
          repliesHandler({
            url: '/i/api/graphql/yyy/UserTweetsAndReplies?variables=...',
            status: 200,
            body: userTweetsAndRepliesBody,
          });
        }
      }),
      scroll: vi.fn().mockResolvedValue(undefined),
    });

    const { getProfile } = await import('../profile.js');
    const result = await getProfile(primitives, { handle: 'hwwaanng', replies: true, count: 5 }) as ProfileWithTimelineResult;

    // Should NOT have intercepted UserTweets pattern
    const hasUserTweets = interceptedPatterns.some(p => p.includes('UserTweets') && !p.includes('UserTweetsAnd'));
    expect(hasUserTweets).toBe(false);

    // Should still return replies
    expect(result.replies).toBeDefined();
    expect(result.replies!.length).toBeGreaterThan(0);

    // Should NOT have posts
    expect(result.posts).toBeUndefined();
  });

  it('--following and --posts are mutually exclusive', async () => {
    const primitives = createMockPrimitives();
    const { getProfile } = await import('../profile.js');
    await expect(getProfile(primitives, { handle: 'test', following: true, posts: true }))
      .rejects.toThrow('--following/--followers cannot be combined with --posts/--replies');
  });
});
