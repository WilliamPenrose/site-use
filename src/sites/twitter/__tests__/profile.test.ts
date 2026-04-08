import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Primitives } from '../../../primitives/types.js';
import type { ProfileResult, FollowListResult } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/golden/profile-sample.json'), 'utf-8',
);
const goldenFollowingBody = fs.readFileSync(
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
    const result = await getProfile(primitives, { handle: 'halo80238964', following: true }) as FollowListResult;

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
    const result = await getProfile(primitives, { handle: 'test', followers: true }) as FollowListResult;

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
