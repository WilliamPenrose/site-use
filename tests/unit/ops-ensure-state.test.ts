import { describe, it, expect, vi } from 'vitest';
import type { Primitives, SnapshotNode, Snapshot } from '../../src/primitives/types.js';
import { ElementNotFound, StateTransitionFailed } from '../../src/errors.js';
import { makeEnsureState } from '../../src/ops/ensure-state.js';

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

describe('ensureState — URL only', () => {
  it('skips navigate when URL already matches', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([])),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ url: 'https://x.com/home' });

    expect(primitives.navigate).not.toHaveBeenCalled();
    expect(result.action).toBe('already_there');
    expect(result.snapshot).toBeDefined();
  });

  it('navigates when URL does not match', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/explore'),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([])),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ url: 'https://x.com/home' });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home');
    expect(result.action).toBe('transitioned');
  });

  it('matches URL with substring', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home/following'),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([])),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ url: 'x.com/home' });

    expect(primitives.navigate).not.toHaveBeenCalled();
    expect(result.action).toBe('already_there');
  });

  it('matches URL with RegExp', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/home'),
      takeSnapshot: vi.fn().mockResolvedValue(buildSnapshot([])),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ url: /x\.com\/home/ });

    expect(primitives.navigate).not.toHaveBeenCalled();
    expect(result.action).toBe('already_there');
  });

  it('throws when RegExp URL does not match (cannot navigate to regex)', async () => {
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/explore'),
    });
    const ensure = makeEnsureState(primitives);

    await expect(
      ensure({ url: /x\.com\/home/ }),
    ).rejects.toThrow(/Cannot navigate/);
  });
});

describe('ensureState — element state', () => {
  it('returns already_there when element state matches', async () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(snapshot),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ role: 'tab', name: 'Following', selected: true });

    expect(primitives.click).not.toHaveBeenCalled();
    expect(result.action).toBe('already_there');
  });

  it('clicks and polls when element state does not match', async () => {
    const beforeSnapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: false },
    ]);
    const afterSnapshot = buildSnapshot([
      { uid: '2', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(beforeSnapshot)   // initial check
        .mockResolvedValueOnce(afterSnapshot),    // poll verification
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ role: 'tab', name: 'Following', selected: true });

    expect(primitives.click).toHaveBeenCalledWith('1');
    expect(result.action).toBe('transitioned');
    expect(result.snapshot).toBe(afterSnapshot);
  });

  it('throws ElementNotFound when element not in snapshot', async () => {
    vi.useFakeTimers();
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Post' },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(snapshot),
    });
    const ensure = makeEnsureState(primitives);

    const promise = ensure({ role: 'tab', name: 'Following', selected: true });
    const assertion = expect(promise).rejects.toThrow(ElementNotFound);

    await vi.advanceTimersByTimeAsync(16_000);

    await assertion;
    vi.useRealTimers();
  });

  it('throws StateTransitionFailed on poll timeout', async () => {
    vi.useFakeTimers();
    const stuckSnapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: false },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(stuckSnapshot),
    });
    const ensure = makeEnsureState(primitives);

    const promise = ensure({ role: 'tab', name: 'Following', selected: true });
    // Attach rejection handler immediately to avoid unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow(StateTransitionFailed);

    // Advance past the 15s poll timeout
    await vi.advanceTimersByTimeAsync(16_000);

    await assertion;
    vi.useRealTimers();
  });
});

describe('ensureState — URL + element combined', () => {
  it('navigates then checks element state', async () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/explore'),
      takeSnapshot: vi.fn().mockResolvedValue(snapshot),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({
      url: 'https://x.com/home',
      role: 'tab',
      name: 'Following',
      selected: true,
    });

    expect(primitives.navigate).toHaveBeenCalledWith('https://x.com/home');
    expect(result.action).toBe('transitioned');
  });
});

describe('ensureState — multiple descriptors', () => {
  it('processes descriptors sequentially', async () => {
    const callOrder: string[] = [];
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      evaluate: vi.fn().mockResolvedValue('https://x.com/explore'),
      navigate: vi.fn().mockImplementation(async () => { callOrder.push('navigate'); }),
      takeSnapshot: vi.fn().mockResolvedValue(snapshot),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure([
      { url: 'https://x.com/home' },
      { role: 'tab', name: 'Following', selected: true },
    ]);

    expect(callOrder).toContain('navigate');
    expect(result.action).toBe('already_there'); // tab was already selected
    expect(result.snapshot).toBeDefined();
  });
});
