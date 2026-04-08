import { describe, it, expect, vi } from 'vitest';
import { createDataCollector } from '../../../ops/data-collector.js';
import type { Primitives } from '../../../primitives/types.js';
import type { UserProfile } from '../types.js';

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
