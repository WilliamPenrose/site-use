import { describe, it, expect, vi } from 'vitest';
import type { Primitives } from '../../src/primitives/types.js';
import { SessionExpired } from '../../src/errors.js';
import {
  createAuthGuardedPrimitives,
  type AuthGuardConfig,
} from '../../src/primitives/auth-guard.js';
import { createMockPrimitives } from '../../src/testing/index.js';

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

    await guarded.navigate('https://x.com/home');

    expect(inner.navigate).toHaveBeenCalledWith('https://x.com/home');
    expect(config.check).toHaveBeenCalledWith(inner);
  });

  it('throws SessionExpired when check returns false', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(false) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await expect(guarded.navigate('https://x.com/home'))
      .rejects.toThrow(SessionExpired);
  });

  it('does not check for non-protected URLs', async () => {
    const inner = createMockPrimitives();
    const config = { ...twitterConfig, check: vi.fn().mockResolvedValue(true) };
    const guarded = createAuthGuardedPrimitives(inner, [config]);

    await guarded.navigate('https://google.com');

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

    await guarded.click('1');
    expect(inner.click).toHaveBeenCalledWith('1');

    await guarded.scroll({ direction: 'down' });
    expect(inner.scroll).toHaveBeenCalledWith({ direction: 'down' });
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

    await guarded.navigate('https://x.com/home');

    // check should receive inner, not guarded
    expect(receivedPrimitives).toBe(inner);
  });
});
