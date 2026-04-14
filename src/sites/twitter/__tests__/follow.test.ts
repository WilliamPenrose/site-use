import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Primitives, SnapshotNode, Snapshot } from '../../../primitives/types.js';

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

function buildSnapshot(nodes: Array<Partial<SnapshotNode> & Pick<SnapshotNode, 'uid' | 'role' | 'name'>>): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) idToNode.set(node.uid, { children: [], ...node } as SnapshotNode);
  return { idToNode };
}

/**
 * Build a mock evaluate function that handles:
 * - location.href check (for login redirect detection)
 * - data-testid DOM query (for DOM-to-ARIA bridge follow button detection)
 * - confirmationSheetConfirm query (for unfollow dialog)
 *
 * followButton: simulates the DOM query result for the follow button.
 *   { state, ariaLabel } — returned when evaluate is called with data-testid query
 */
function mockEvaluate(opts: {
  url?: string;
  followButton?: { state: 'following' | 'not_following' | 'pending'; ariaLabel: string } | null;
  confirmText?: string | null;
} = {}) {
  const { url = 'https://x.com/testuser', followButton, confirmText } = opts;
  return vi.fn().mockImplementation(async (expr: string) => {
    if (expr.includes('location.href')) return url;
    // Error page check (locale-agnostic via data-testid)
    if (expr.includes('emptyState')) return null;
    // DOM-to-ARIA bridge: unfollow confirmation dialog
    if (expr.includes('confirmationSheetConfirm')) {
      return confirmText ?? null;
    }
    // DOM-to-ARIA bridge: follow button detection (query contains all three: -unfollow, -follow, -cancel)
    if (expr.includes('"-cancel"')) {
      return followButton ?? null;
    }
    return undefined;
  });
}

let follow: typeof import('../workflows.js').follow;
let unfollow: typeof import('../workflows.js').unfollow;

beforeEach(async () => {
  const mod = await import('../workflows.js');
  follow = mod.follow;
  unfollow = mod.unfollow;
});

describe('follow', () => {
  it('follows user when Follow button is found', async () => {
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('emptyState')) return null; // no error page
        if (expr.includes('"-cancel"')) {
          evalCount++;
          // First call: not_following; subsequent calls: following (after click)
          if (evalCount <= 1) return { state: 'not_following', ariaLabel: 'Follow @testuser' };
          return { state: 'following', ariaLabel: 'Following @testuser' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '42', role: 'button', name: 'Follow @testuser' },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '43', role: 'button', name: 'Following @testuser' },
        ])),
    });

    const result = await follow(primitives, { handle: 'testuser' });

    expect(result).toEqual({
      action: 'follow',
      handle: 'testuser',
      success: true,
      previousState: 'not_following',
      resultState: 'following',
    });
    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/testuser');
    expect(primitives.click).toHaveBeenCalledWith('42');
  });

  it('returns noop when already following', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ followButton: { state: 'following', ariaLabel: 'Following @testuser' } }),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Following @testuser' },
      ])),
    });

    const result = await follow(primitives, { handle: 'testuser' });

    expect(result.previousState).toBe('following');
    expect(result.resultState).toBe('following');
    expect(result.success).toBe(true);
    expect(primitives.click).not.toHaveBeenCalled();
  });

  it('returns noop when already pending (protected account)', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ followButton: { state: 'pending', ariaLabel: '未承認' } }),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: '未承認' },
      ])),
    });

    const result = await follow(primitives, { handle: '@testuser' });

    expect(result.previousState).toBe('pending');
    expect(result.resultState).toBe('pending');
    expect(result.success).toBe(true);
    expect(primitives.click).not.toHaveBeenCalled();
  });

  it('detects pending via -cancel testid (protected account)', async () => {
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('emptyState')) return null;
        if (expr.includes('confirmationSheetConfirm')) return null;
        if (expr.includes('"-cancel"')) {
          evalCount++;
          // 1st call: not_following (before click)
          if (evalCount <= 1) return { state: 'not_following', ariaLabel: 'フォロー @testuser' };
          // 2nd call: pending (after click, testid became -cancel)
          return { state: 'pending', ariaLabel: '未承認' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '42', role: 'button', name: 'フォロー @testuser' },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '43', role: 'button', name: '未承認' },
        ])),
    });

    const result = await follow(primitives, { handle: 'testuser' });

    expect(result.success).toBe(true);
    expect(result.previousState).toBe('not_following');
    expect(result.resultState).toBe('pending');
    expect(primitives.click).toHaveBeenCalledWith('42');
  });

  it('normalizes handle with @ prefix', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ followButton: { state: 'following', ariaLabel: 'Following @testuser' } }),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Following @testuser' },
      ])),
    });

    await follow(primitives, { handle: '@testuser' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/testuser');
  });

  it('resolves handle from profile URL', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ followButton: { state: 'following', ariaLabel: 'Following @elonmusk' } }),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Following @elonmusk' },
      ])),
    });

    await follow(primitives, { url: 'https://x.com/elonmusk' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/elonmusk');
  });

  it('works with non-English locale (Japanese)', async () => {
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('emptyState')) return null; // no error page
        if (expr.includes('"-cancel"')) {
          evalCount++;
          if (evalCount <= 1) return { state: 'not_following', ariaLabel: 'フォロー @testuser' };
          return { state: 'following', ariaLabel: 'フォロー中 @testuser' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '42', role: 'button', name: 'フォロー @testuser' },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '43', role: 'button', name: 'フォロー中 @testuser' },
        ])),
    });

    const result = await follow(primitives, { handle: 'testuser' });

    expect(result.success).toBe(true);
    expect(result.previousState).toBe('not_following');
    expect(result.resultState).toBe('following');
    expect(primitives.click).toHaveBeenCalledWith('42');
  });

  it('throws on login redirect', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ url: 'https://x.com/i/flow/login' }),
    });

    await expect(follow(primitives, { handle: 'testuser' }))
      .rejects.toThrow('Not logged in');
  });

  it('throws when user does not exist (via data-testid)', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/nonexistent';
        // data-testid="emptyState" present → user not found
        if (expr.includes('emptyState')) return 'emptyState';
        if (expr.includes('data-testid')) return null;
        return undefined;
      }),
    });

    await expect(follow(primitives, { handle: 'nonexistent' }))
      .rejects.toThrow('does not exist or is suspended');
  });

  it('rejects reserved path as handle from URL', async () => {
    const primitives = createMockPrimitives();

    await expect(follow(primitives, { url: 'https://x.com/home' }))
      .rejects.toThrow('Cannot extract handle from URL');
  });

  it('rejects explore path from URL', async () => {
    const primitives = createMockPrimitives();

    await expect(follow(primitives, { url: 'https://x.com/explore' }))
      .rejects.toThrow('Cannot extract handle from URL');
  });

  it('throws when neither handle nor url provided', async () => {
    const primitives = createMockPrimitives();

    await expect(follow(primitives, {}))
      .rejects.toThrow('Either handle or url is required');
  });
});

describe('unfollow', () => {
  it('unfollows user via DOM-to-ARIA bridge (exact match)', async () => {
    let snapshotCount = 0;
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        // Check confirmationSheetConfirm BEFORE data-testid (confirm query contains both)
        if (expr.includes('confirmationSheetConfirm')) return 'Unfollow';
        if (expr.includes('emptyState')) return null; // no error page
        if (expr.includes('"-cancel"')) {
          evalCount++;
          if (evalCount <= 1) return { state: 'following', ariaLabel: 'Following @testuser' };
          return { state: 'not_following', ariaLabel: 'Follow @testuser' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn().mockImplementation(async () => {
        snapshotCount++;
        if (snapshotCount === 1) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'Following @testuser' },
          ]);
        }
        if (snapshotCount === 2) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'Following @testuser' },
            { uid: '99', role: 'button', name: 'Unfollow' },
          ]);
        }
        return buildSnapshot([
          { uid: '43', role: 'button', name: 'Follow @testuser' },
        ]);
      }),
    });

    const result = await unfollow(primitives, { handle: 'testuser' });

    expect(result).toEqual({
      action: 'unfollow',
      handle: 'testuser',
      success: true,
      previousState: 'following',
      resultState: 'not_following',
    });
    expect(primitives.click).toHaveBeenCalledWith('42');  // Following button
    expect(primitives.click).toHaveBeenCalledWith('99');  // Confirm button via ARIA
  });

  it('returns noop when not following', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ followButton: { state: 'not_following', ariaLabel: 'Follow @testuser' } }),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Follow @testuser' },
      ])),
    });

    const result = await unfollow(primitives, { handle: 'testuser' });

    expect(result.previousState).toBe('not_following');
    expect(result.resultState).toBe('not_following');
    expect(primitives.click).not.toHaveBeenCalled();
  });

  it('cancels pending follow request via confirmation dialog', async () => {
    let snapshotCount = 0;
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('emptyState')) return null;
        if (expr.includes('confirmationSheetConfirm')) return '破棄';
        if (expr.includes('"-cancel"')) {
          evalCount++;
          // Pre-click: pending
          if (evalCount <= 1) return { state: 'pending', ariaLabel: '未承認' };
          // Post-confirm: not_following
          return { state: 'not_following', ariaLabel: 'フォロー @testuser' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn().mockImplementation(async () => {
        snapshotCount++;
        if (snapshotCount === 1) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: '未承認' },
          ]);
        }
        if (snapshotCount === 2) {
          // Confirmation dialog appeared
          return buildSnapshot([
            { uid: '42', role: 'button', name: '未承認' },
            { uid: '99', role: 'button', name: '破棄' },
          ]);
        }
        return buildSnapshot([
          { uid: '43', role: 'button', name: 'フォロー @testuser' },
        ]);
      }),
    });

    const result = await unfollow(primitives, { handle: 'testuser' });

    expect(result).toEqual({
      action: 'unfollow',
      handle: 'testuser',
      success: true,
      previousState: 'pending',
      resultState: 'not_following',
    });
    expect(primitives.click).toHaveBeenCalledWith('42');  // Cancel button
    expect(primitives.click).toHaveBeenCalledWith('99');  // Confirm dialog
  });

  it('unfollows via DOM-to-ARIA bridge with non-English locale (fuzzy match)', async () => {
    let snapshotCount = 0;
    let evalCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('confirmationSheetConfirm')) return '取消关注';
        if (expr.includes('emptyState')) return null; // no error page
        if (expr.includes('"-cancel"')) {
          evalCount++;
          if (evalCount <= 1) return { state: 'following', ariaLabel: 'フォロー中 @testuser' };
          return { state: 'not_following', ariaLabel: 'フォロー @testuser' };
        }
        return undefined;
      }),
      takeSnapshot: vi.fn().mockImplementation(async () => {
        snapshotCount++;
        if (snapshotCount === 1) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'フォロー中 @testuser' },
          ]);
        }
        if (snapshotCount === 2) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'フォロー中 @testuser' },
            { uid: '99', role: 'button', name: '取消关注' },
          ]);
        }
        return buildSnapshot([
          { uid: '43', role: 'button', name: 'フォロー @testuser' },
        ]);
      }),
    });

    const result = await unfollow(primitives, { handle: 'testuser' });
    expect(result.resultState).toBe('not_following');
    expect(primitives.click).toHaveBeenCalledWith('99');
  });

  it('throws StateTransitionFailed when ARIA match fails (no direct click fallback)', async () => {
    let snapshotCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        if (expr.includes('emptyState')) return null;
        if (expr.includes('confirmationSheetConfirm')) return 'SomeText';
        if (expr.includes('"-follow"') || expr.includes('"-unfollow"')) return { state: 'following', ariaLabel: 'Following @testuser' };
        return undefined;
      }),
      takeSnapshot: vi.fn().mockImplementation(async () => {
        snapshotCount++;
        if (snapshotCount === 1) {
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'Following @testuser' },
          ]);
        }
        // Dialog snapshot: button name does NOT match DOM text 'SomeText'
        return buildSnapshot([
          { uid: '42', role: 'button', name: 'Following @testuser' },
          { uid: '99', role: 'button', name: 'CompletelyDifferent' },
        ]);
      }),
    });

    await expect(unfollow(primitives, { handle: 'testuser' }))
      .rejects.toThrow('no ARIA match');
  });

  it('throws on login redirect', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ url: 'https://x.com/i/flow/login' }),
    });

    await expect(unfollow(primitives, { handle: 'testuser' }))
      .rejects.toThrow('Not logged in');
  });
});
