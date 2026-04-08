import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { createDataCollector } from '../../../ops/data-collector.js';
import type { Primitives } from '../../../primitives/types.js';
import type { UserProfile } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/following-sample.json'), 'utf-8',
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
    interceptRequestWithControl: vi.fn().mockResolvedValue({ cleanup: () => {}, reset: () => {} }),
    getRawPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const fakeUser: UserProfile = {
  userId: '1', handle: 'test', displayName: 'Test', bio: '',
  followersCount: 0, followingCount: 0, tweetsCount: 0, likesCount: 0,
  verified: false, createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
};

describe('collectFollowList', () => {
  it('returns immediately when collector already has enough data', async () => {
    const collector = createDataCollector<UserProfile>();
    collector.push(fakeUser, { ...fakeUser, userId: '2' }, { ...fakeUser, userId: '3' });
    const primitives = createMockPrimitives();

    const { collectFollowList } = await import('../follow-list.js');
    const result = await collectFollowList(primitives, collector, { count: 3 });

    expect(result.scrollRounds).toBe(0);
    expect(primitives.scroll).not.toHaveBeenCalled();
  });

  it('scrolls and collects until count is reached', async () => {
    const collector = createDataCollector<UserProfile>();
    let scrollCount = 0;
    const primitives = createMockPrimitives({
      scroll: vi.fn().mockImplementation(async () => {
        scrollCount++;
        // Simulate data arriving after each scroll
        collector.push({ ...fakeUser, userId: `scroll-${scrollCount}` });
      }),
    });

    const { collectFollowList } = await import('../follow-list.js');
    const result = await collectFollowList(primitives, collector, { count: 3 });

    expect(collector.length).toBe(3);
    expect(result.scrollRounds).toBe(3);
  });

  it('stops after 1 stale round (MAX_STALE_ROUNDS = 1)', async () => {
    const collector = createDataCollector<UserProfile>();
    collector.push(fakeUser);
    const primitives = createMockPrimitives({
      scroll: vi.fn().mockResolvedValue(undefined),
      // No data pushed after scroll → stale
    });

    const { collectFollowList } = await import('../follow-list.js');
    const result = await collectFollowList(primitives, collector, { count: 10 });

    // Should stop after exactly 1 stale round, not 3 like feed
    expect(result.scrollRounds).toBe(1);
    expect(collector.length).toBe(1);
  });
});

describe('getFollowList', () => {
  it('returns follow list for a handle', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Following', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => { interceptHandler = null; };
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/halo80238964/following')  // checkLoginRedirect
        .mockResolvedValueOnce(null),                                    // checkProfileError
    });

    const { getFollowList } = await import('../follow-list.js');
    const result = await getFollowList(primitives, { handle: 'halo80238964', direction: 'following' });

    expect(result.users.length).toBe(5);
    expect(result.users[0].handle).toBe('Oracle');
    expect(result.meta.owner).toBe('halo80238964');
    expect(result.meta.totalReturned).toBe(5);
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/halo80238964/following');
  });

  it('navigates to /followers for followers direction', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Followers', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/test/followers')
        .mockResolvedValueOnce(null),
    });

    const { getFollowList } = await import('../follow-list.js');
    await getFollowList(primitives, { handle: 'test', direction: 'followers' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/test/followers');
  });

  it('uses self handle when no handle/url provided', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Following', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('myhandle')     // getSelfHandle
        .mockResolvedValueOnce('https://x.com/myhandle/following')  // checkLoginRedirect
        .mockResolvedValueOnce(null),           // checkProfileError
    });

    const { getFollowList } = await import('../follow-list.js');
    const result = await getFollowList(primitives, { direction: 'following' });

    expect(result.meta.owner).toBe('myhandle');
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/myhandle/following');
  });

  it('throws when no handle and self handle unavailable', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue(null),  // getSelfHandle returns null
    });

    const { getFollowList } = await import('../follow-list.js');
    await expect(getFollowList(primitives, { direction: 'following' }))
      .rejects.toThrow('Cannot determine logged-in user');
  });

  it('throws SessionExpired when redirected to login', async () => {
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/i/flow/login'),
    });

    const { getFollowList } = await import('../follow-list.js');
    await expect(getFollowList(primitives, { handle: 'test', direction: 'following' }))
      .rejects.toThrow('Not logged in');
  });

  it('throws UserNotFound for nonexistent user', async () => {
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/nonexistent/following')
        .mockResolvedValueOnce('emptyState'),
    });

    const { getFollowList } = await import('../follow-list.js');
    await expect(getFollowList(primitives, { handle: 'nonexistent', direction: 'following' }))
      .rejects.toThrow('does not exist');
  });

  it('throws ElementNotFound when GraphQL response times out', async () => {
    vi.useFakeTimers();
    const primitives = createMockPrimitives({
      interceptRequest: vi.fn().mockResolvedValue(() => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/slow/following')
        .mockResolvedValue(null),
    });

    const { getFollowList } = await import('../follow-list.js');
    try {
      const promise = getFollowList(primitives, { handle: 'slow', direction: 'following' });
      const assertion = expect(promise).rejects.toThrow('No following data received');
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('slices results to count', async () => {
    let interceptHandler: any = null;
    const primitives = createMockPrimitives({
      navigate: vi.fn().mockImplementation(async () => {
        if (interceptHandler) {
          interceptHandler({ url: '/i/api/graphql/abc/Following', status: 200, body: goldenBody });
        }
      }),
      interceptRequest: vi.fn().mockImplementation(async (_pattern: RegExp, handler: any) => {
        interceptHandler = handler;
        return () => {};
      }),
      evaluate: vi.fn()
        .mockResolvedValueOnce('https://x.com/test/following')
        .mockResolvedValueOnce(null),
    });

    const { getFollowList } = await import('../follow-list.js');
    const result = await getFollowList(primitives, { handle: 'test', direction: 'following', count: 2 });

    expect(result.users.length).toBe(2);
    expect(result.meta.totalReturned).toBe(2);
  });
});
