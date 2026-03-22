import { describe, it, expect, vi } from 'vitest';
import type { Primitives } from '../../src/primitives/types.js';
import { SessionExpired } from '../../src/errors.js';
import {
  createAuthGuardedPrimitives,
  type AuthGuardConfig,
} from '../../src/primitives/auth-guard.js';

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

const twitterConfig: AuthGuardConfig = {
  site: 'twitter',
  domains: ['x.com', 'twitter.com'],
  check: vi.fn().mockResolvedValue(true),
};

describe('createAuthGuardedPrimitives', () => {
  it('calls inner.navigate then check on protected domain', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(true) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await guarded.navigate('https://x.com/home', 'twitter');

    expect(inner.navigate).toHaveBeenCalledWith('https://x.com/home', 'twitter');
    expect(config.check).toHaveBeenCalledWith(inner);
  });

  it('throws SessionExpired when check returns false', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(false) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await expect(guarded.navigate('https://x.com/home', 'twitter'))
      .rejects.toThrow(SessionExpired);
  });

  it('does not check for non-protected URLs', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(true) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await guarded.navigate('https://google.com', 'other');

    expect(inner.navigate).toHaveBeenCalled();
    expect(config.check).not.toHaveBeenCalled();
  });

  it('does not check for data: URLs', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(true) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await guarded.navigate('data:text/html,hello');

    expect(config.check).not.toHaveBeenCalled();
  });

  it('passes through non-navigate operations unchanged', async () => {
    const inner = createMockPrimitives();
    const guarded = createAuthGuardedPrimitives(inner, [twitterConfig]);

    await guarded.click('1', 'twitter');
    expect(inner.click).toHaveBeenCalledWith('1', 'twitter');

    await guarded.scroll({ direction: 'down' }, 'twitter');
    expect(inner.scroll).toHaveBeenCalledWith({ direction: 'down' }, 'twitter');
  });

  it('check receives inner primitives (not guarded) to avoid recursion', async () => {
    const inner = createMockPrimitives();
    let receivedPrimitives: Primitives | null = null;
    const config: AuthGuardConfig = {
      ...twitterConfig,
      check: vi.fn().mockImplementation(async (p: Primitives) => {
        receivedPrimitives = p;
        return true;
      }),
    };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await guarded.navigate('https://x.com/home', 'twitter');

    // check should receive inner, not guarded
    expect(receivedPrimitives).toBe(inner);
  });
});
