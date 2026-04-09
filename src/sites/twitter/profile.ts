import type { Primitives } from '../../primitives/types.js';
import type { ProfileResult, FollowListResult } from './types.js';
import { resolveHandle, checkLoginRedirect, checkProfileError, getSelfHandle } from './navigate.js';
import { parseProfileResponse, GRAPHQL_PROFILE_PATTERN } from './extractors.js';
import { SiteUseError } from '../../errors.js';
import { NOOP_TRACE, type Trace } from '../../trace.js';
import { getFollowList } from './follow-list.js';

const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_POLL_INTERVAL_MS = 500;

/**
 * Unified profile entry point.
 * Dispatches to follow-list mode when --following or --followers is set,
 * otherwise returns basic profile info.
 */
export async function getProfile(
  primitives: Primitives,
  opts: {
    handle?: string;
    url?: string;
    following?: boolean;
    followers?: boolean;
    count?: number;
    debug?: boolean;
  },
  trace: Trace = NOOP_TRACE,
): Promise<ProfileResult | FollowListResult> {
  if (opts.following) {
    return getFollowList(primitives, { ...opts, direction: 'following' }, trace);
  }
  if (opts.followers) {
    return getFollowList(primitives, { ...opts, direction: 'followers' }, trace);
  }
  return getProfileInfo(primitives, opts, trace);
}

/**
 * Fetch basic profile info (original #5 logic).
 */
async function getProfileInfo(
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

      if (!captured) {
        const deadline = Date.now() + PROFILE_TIMEOUT_MS;
        while (!captured && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, PROFILE_POLL_INTERVAL_MS));
          await checkProfileError(primitives, handle, 'profile');
        }
      }

      if (!captured) {
        throw new SiteUseError('ElementNotFound',
          `No UserByScreenName response received for @${handle} within ${PROFILE_TIMEOUT_MS / 1000}s`,
          { retryable: true, step: 'profile: waiting for GraphQL response' },
        );
      }

      const selfHandle = await getSelfHandle(primitives);
      const result = parseProfileResponse(captured, selfHandle ?? undefined);
      rootSpan.set('userId', result.user.userId);
      rootSpan.set('isSelf', result.relationship === null);

      return result;
    } finally {
      cleanup();
    }
  });
}
