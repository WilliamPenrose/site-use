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

beforeEach(async () => {
  const mod = await import('../../src/sites/twitter/workflows.js');
  checkLogin = mod.checkLogin;
  requireLogin = mod.requireLogin;
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
