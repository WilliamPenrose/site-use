import type { Primitives } from '../../primitives/types.js';
import type { ProfileResult } from './types.js';
import { resolveHandle, checkLoginRedirect, checkProfileError } from './navigate.js';
import { parseProfileResponse, GRAPHQL_PROFILE_PATTERN } from './extractors.js';
import { SiteUseError } from '../../errors.js';
import { NOOP_TRACE, type Trace } from '../../trace.js';

const PROFILE_TIMEOUT_MS = 10_000;

export async function getProfile(
  primitives: Primitives,
  opts: { handle?: string; url?: string; debug?: boolean },
  trace: Trace = NOOP_TRACE,
): Promise<ProfileResult> {
  const handle = resolveHandle(opts);

  return await trace.span('getProfile', async (rootSpan) => {
    rootSpan.set('handle', handle);

    let captured: string | null = null;

    const cleanup = await primitives.interceptRequest(
      GRAPHQL_PROFILE_PATTERN,
      (response) => {
        if (!captured) {
          captured = response.body;
        }
      },
    );

    try {
      await primitives.navigate(`https://x.com/${handle}`);
      await checkLoginRedirect(primitives, rootSpan);
      await checkProfileError(primitives, handle, 'profile');

      // Wait for GraphQL response if not already captured
      if (!captured) {
        const deadline = Date.now() + PROFILE_TIMEOUT_MS;
        while (!captured && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 500));
          await checkProfileError(primitives, handle, 'profile');
        }
      }

      if (!captured) {
        throw new SiteUseError('ElementNotFound',
          `No UserByScreenName response received for @${handle} within ${PROFILE_TIMEOUT_MS / 1000}s`,
          { retryable: true, step: 'profile: waiting for GraphQL response' },
        );
      }

      // Detect self-profile: get logged-in user handle from DOM
      const selfHandle = await primitives.evaluate<string | null>(`(() => {
        const el = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        return el ? el.getAttribute('href')?.replace('/', '') ?? null : null;
      })()`);

      const result = parseProfileResponse(captured, selfHandle ?? undefined);
      rootSpan.set('userId', result.user.userId);
      rootSpan.set('isSelf', result.relationship === null);

      return result;
    } finally {
      cleanup();
    }
  });
}
