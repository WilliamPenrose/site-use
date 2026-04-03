import { describe, it, expect, vi } from 'vitest';
import { ElementNotFound, StateTransitionFailed } from '../../src/errors.js';
import { makeEnsureState } from '../../src/ops/ensure-state.js';
import { createMockPrimitives, buildSnapshot } from '../../src/testing/index.js';

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

  it('retries click with fresh snapshot when click throws', async () => {
    const beforeSnapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: false },
    ]);
    const freshSnapshot = buildSnapshot([
      { uid: '2', role: 'tab', name: 'Following', selected: false },
    ]);
    const afterSnapshot = buildSnapshot([
      { uid: '3', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(beforeSnapshot)   // initial find
        .mockResolvedValueOnce(freshSnapshot)    // re-snapshot after click failure
        .mockResolvedValueOnce(afterSnapshot),   // poll verification
      click: vi.fn()
        .mockRejectedValueOnce(new Error('Element did not stabilize'))
        .mockResolvedValueOnce(undefined),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ role: 'tab', name: 'Following', selected: true });

    expect(primitives.click).toHaveBeenCalledTimes(2);
    expect(primitives.click).toHaveBeenNthCalledWith(1, '1'); // stale uid
    expect(primitives.click).toHaveBeenNthCalledWith(2, '2'); // fresh uid
    expect(result.action).toBe('transitioned');
  });

  it('skips retry click if condition already met after re-snapshot', async () => {
    const beforeSnapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: false },
    ]);
    const alreadyDoneSnapshot = buildSnapshot([
      { uid: '2', role: 'tab', name: 'Following', selected: true },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn()
        .mockResolvedValueOnce(beforeSnapshot)
        .mockResolvedValueOnce(alreadyDoneSnapshot),
      click: vi.fn()
        .mockRejectedValueOnce(new Error('Element did not stabilize')),
    });
    const ensure = makeEnsureState(primitives);

    const result = await ensure({ role: 'tab', name: 'Following', selected: true });

    expect(primitives.click).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('transitioned');
  });

  it('throws after exhausting click retries', async () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following', selected: false },
    ]);
    const primitives = createMockPrimitives({
      takeSnapshot: vi.fn().mockResolvedValue(snapshot),
      click: vi.fn().mockRejectedValue(new Error('Element did not stabilize')),
    });
    const ensure = makeEnsureState(primitives);

    await expect(
      ensure({ role: 'tab', name: 'Following', selected: true }),
    ).rejects.toThrow('Element did not stabilize');

    // 1 initial + 2 retries = 3 total
    expect(primitives.click).toHaveBeenCalledTimes(3);
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
