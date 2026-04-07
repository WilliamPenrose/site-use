import { describe, it, expect, vi } from 'vitest';
import { normalizeHandle, handleFromUrl, resolveHandle, checkLoginRedirect, checkProfileError } from '../navigate.js';
import type { Primitives } from '../../../primitives/types.js';
import { NOOP_SPAN } from '../../../trace.js';

describe('normalizeHandle', () => {
  it('strips @ prefix', () => {
    expect(normalizeHandle('@elonmusk')).toBe('elonmusk');
  });

  it('passes through handle without @', () => {
    expect(normalizeHandle('elonmusk')).toBe('elonmusk');
  });

  it('throws on invalid characters', () => {
    expect(() => normalizeHandle('elon musk')).toThrow('Invalid Twitter handle');
  });

  it('throws on handle longer than 15 chars', () => {
    expect(() => normalizeHandle('a'.repeat(16))).toThrow('Invalid Twitter handle');
  });

  it('accepts underscores and digits', () => {
    expect(normalizeHandle('user_123')).toBe('user_123');
  });
});

describe('handleFromUrl', () => {
  it('extracts handle from x.com URL', () => {
    expect(handleFromUrl('https://x.com/elonmusk')).toBe('elonmusk');
  });

  it('extracts handle from twitter.com URL', () => {
    expect(handleFromUrl('https://twitter.com/elonmusk')).toBe('elonmusk');
  });

  it('strips query parameters', () => {
    expect(handleFromUrl('https://x.com/elonmusk?ref=home')).toBe('elonmusk');
  });

  it('returns null for non-Twitter URL', () => {
    expect(handleFromUrl('https://google.com/elonmusk')).toBeNull();
  });

  it('returns null for reserved path', () => {
    expect(handleFromUrl('https://x.com/home')).toBeNull();
    expect(handleFromUrl('https://x.com/search')).toBeNull();
    expect(handleFromUrl('https://x.com/settings')).toBeNull();
    expect(handleFromUrl('https://x.com/messages')).toBeNull();
  });

  it('returns null for invalid handle in URL', () => {
    expect(handleFromUrl('https://x.com/elon musk')).toBeNull();
  });
});

describe('resolveHandle', () => {
  it('prefers handle over url', () => {
    expect(resolveHandle({ handle: 'test', url: 'https://x.com/other' })).toBe('test');
  });

  it('falls back to url when no handle', () => {
    expect(resolveHandle({ url: 'https://x.com/elonmusk' })).toBe('elonmusk');
  });

  it('throws when url cannot be parsed', () => {
    expect(() => resolveHandle({ url: 'https://google.com/test' })).toThrow('Cannot extract handle');
  });

  it('throws when neither handle nor url provided', () => {
    expect(() => resolveHandle({})).toThrow('Either handle or url is required');
  });
});

describe('checkLoginRedirect', () => {
  function mockPrimitives(url: string): Primitives {
    return {
      evaluate: vi.fn().mockResolvedValue(url),
    } as unknown as Primitives;
  }

  it('does not throw for normal Twitter URL', async () => {
    await expect(checkLoginRedirect(mockPrimitives('https://x.com/elonmusk'))).resolves.toBeUndefined();
  });

  it('throws SessionExpired for /login redirect', async () => {
    await expect(checkLoginRedirect(mockPrimitives('https://x.com/login'))).rejects.toThrow('Not logged in');
  });

  it('throws SessionExpired for /i/flow/login redirect', async () => {
    await expect(checkLoginRedirect(mockPrimitives('https://x.com/i/flow/login'))).rejects.toThrow('Not logged in');
  });
});

describe('checkProfileError', () => {
  function mockPrimitives(evaluateReturn: string | null): Primitives {
    return {
      evaluate: vi.fn().mockResolvedValue(evaluateReturn),
    } as unknown as Primitives;
  }

  it('does not throw when no error detected', async () => {
    await expect(checkProfileError(mockPrimitives(null), 'test')).resolves.toBeUndefined();
  });

  it('throws Blocked for blocked user', async () => {
    await expect(checkProfileError(mockPrimitives('blocked'), 'test')).rejects.toThrow('blocked by @test');
  });

  it('throws UserNotFound for emptyState (suspended/nonexistent)', async () => {
    await expect(checkProfileError(mockPrimitives('emptyState'), 'test')).rejects.toThrow('does not exist');
  });

  it('throws UserNotFound for errorDetail (invalid path)', async () => {
    await expect(checkProfileError(mockPrimitives('errorDetail'), 'test')).rejects.toThrow('not found');
  });

  it('uses context parameter in error step field', async () => {
    try {
      await checkProfileError(mockPrimitives('blocked'), 'test', 'profile');
    } catch (e: any) {
      expect(e.context.step).toContain('profile:');
    }
  });

  it('defaults context to navigate', async () => {
    try {
      await checkProfileError(mockPrimitives('blocked'), 'test');
    } catch (e: any) {
      expect(e.context.step).toContain('navigate:');
    }
  });
});
