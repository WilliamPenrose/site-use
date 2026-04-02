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
    getRawPage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

// Note: SnapshotNode has optional fields (children, value, etc.) but findByDescriptor
// iterates idToNode Map values flat (not tree recursion), so only uid/role/name are needed.
function buildSnapshot(nodes: Array<Partial<SnapshotNode> & Pick<SnapshotNode, 'uid' | 'role' | 'name'>>): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) idToNode.set(node.uid, { children: [], ...node } as SnapshotNode);
  return { idToNode };
}

function mockEvaluate(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'location.href': 'https://x.com/testuser',
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

let follow: typeof import('../workflows.js').follow;
let unfollow: typeof import('../workflows.js').unfollow;

beforeEach(async () => {
  const mod = await import('../workflows.js');
  follow = mod.follow;
  unfollow = mod.unfollow;
});

describe('follow', () => {
  it('follows user when Follow button is found', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
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
      evaluate: mockEvaluate(),
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

  it('returns noop when pending (protected account)', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Pending @testuser' },
      ])),
    });

    const result = await follow(primitives, { handle: '@testuser' });

    expect(result.previousState).toBe('pending');
    expect(result.resultState).toBe('pending');
    expect(primitives.click).not.toHaveBeenCalled();
  });

  it('handles protected account: Follow → Pending', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(buildSnapshot([
          { uid: '42', role: 'button', name: 'Follow @testuser' },
        ]))
        .mockResolvedValue(buildSnapshot([
          { uid: '43', role: 'button', name: 'Pending @testuser' },
        ])),
    });

    const result = await follow(primitives, { handle: 'testuser' });

    expect(result.resultState).toBe('pending');
    expect(result.success).toBe(true);
  });

  it('normalizes handle with @ prefix', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Following @testuser' },
      ])),
    });

    await follow(primitives, { handle: '@testuser' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/testuser');
  });

  it('resolves handle from profile URL', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Following @elonmusk' },
      ])),
    });

    await follow(primitives, { url: 'https://x.com/elonmusk' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/elonmusk');
  });

  it('throws on login redirect', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate({ 'location.href': 'https://x.com/i/flow/login' }),
    });

    await expect(follow(primitives, { handle: 'testuser' }))
      .rejects.toThrow('Not logged in');
  });

  it('throws when user does not exist', async () => {
    const primitives = createMockPrimitives({
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '1', role: 'heading', name: "This account doesn't exist" },
      ])),
    });

    await expect(follow(primitives, { handle: 'nonexistent' }))
      .rejects.toThrow('does not exist or is suspended');
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
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        // DOM-to-ARIA bridge: return confirm button textContent
        if (expr.includes('confirmationSheetConfirm')) return 'Unfollow';
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
          // Dialog snapshot: button with matching text
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
      evaluate: mockEvaluate(),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([
        { uid: '42', role: 'button', name: 'Follow @testuser' },
      ])),
    });

    const result = await unfollow(primitives, { handle: 'testuser' });

    expect(result.previousState).toBe('not_following');
    expect(result.resultState).toBe('not_following');
    expect(primitives.click).not.toHaveBeenCalled();
  });

  it('unfollows via DOM-to-ARIA bridge with non-English locale (fuzzy match)', async () => {
    let snapshotCount = 0;
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockImplementation(async (expr: string) => {
        if (expr.includes('location.href')) return 'https://x.com/testuser';
        // Chinese locale: textContent is "取消关注"
        if (expr.includes('confirmationSheetConfirm')) return '取消关注';
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
          // ARIA name matches the DOM textContent
          return buildSnapshot([
            { uid: '42', role: 'button', name: 'Following @testuser' },
            { uid: '99', role: 'button', name: '取消关注' },
          ]);
        }
        return buildSnapshot([
          { uid: '43', role: 'button', name: 'Follow @testuser' },
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
        // DOM has text but ARIA snapshot won't have a matching button
        if (expr.includes('confirmationSheetConfirm')) return 'SomeText';
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
      evaluate: mockEvaluate({ 'location.href': 'https://x.com/i/flow/login' }),
    });

    await expect(unfollow(primitives, { handle: 'testuser' }))
      .rejects.toThrow('Not logged in');
  });
});
