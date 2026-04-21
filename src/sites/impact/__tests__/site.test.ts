import { describe, expect, it, vi } from 'vitest';
import type { Primitives } from '../../../primitives/types.js';
import { IMPACT_DISCOVERY_URL, isLoggedIn } from '../site.js';

describe('isLoggedIn', () => {
  it('treats the discovery page as logged in even if account selector is missing', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce('Impact Marketplace')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(IMPACT_DISCOVERY_URL);
    const primitives = { evaluate } as unknown as Primitives;

    await expect(isLoggedIn(primitives)).resolves.toEqual({ loggedIn: true });
  });

  it('returns false on the login page', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce('impact.com Login - Partnership Management Platform');
    const primitives = { evaluate } as unknown as Primitives;

    await expect(isLoggedIn(primitives)).resolves.toEqual({
      loggedIn: false,
      diagnostics: {
        reason: 'login_page',
        title: 'impact.com Login - Partnership Management Platform',
      },
    });
  });
});
