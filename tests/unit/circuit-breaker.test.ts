import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/browser/browser.js', () => ({
  ensureBrowser: vi.fn(),
  isBrowserConnected: vi.fn().mockReturnValue(true),
}));

import {
  formatToolError,
  resetErrorStreak,
  _setPrimitivesForTest,
  _getErrorStreak,
} from '../../src/server.js';
import {
  NavigationFailed,
  BrowserDisconnected,
  RateLimited,
} from '../../src/errors.js';

beforeEach(() => {
  _setPrimitivesForTest(null);
  resetErrorStreak();
});

describe('circuit breaker', () => {
  it('throws RateLimited after 5 consecutive errors, preserving last error info', async () => {
    for (let i = 0; i < 4; i++) {
      await formatToolError(new NavigationFailed('timeout'));
    }
    const result = await formatToolError(new NavigationFailed('timeout'));
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.type).toBe('RateLimited');
    expect(payload.context.hint).toContain('circuit breaker');
    expect(payload.message).toContain('NavigationFailed');
    expect(payload.context.hint).toContain('timeout');
  });

  it('resets counter on success', async () => {
    for (let i = 0; i < 3; i++) {
      await formatToolError(new NavigationFailed('timeout'));
    }
    resetErrorStreak();
    for (let i = 0; i < 4; i++) {
      await formatToolError(new NavigationFailed('timeout'));
    }
    expect(_getErrorStreak()).toBe(4);
  });

  it('does not count BrowserDisconnected', async () => {
    for (let i = 0; i < 10; i++) {
      await formatToolError(new BrowserDisconnected('crashed'));
    }
    expect(_getErrorStreak()).toBe(0);
  });

  it('does not count RateLimited (avoid re-triggering)', async () => {
    await formatToolError(new RateLimited('already limited'));
    expect(_getErrorStreak()).toBe(0);
  });
});
