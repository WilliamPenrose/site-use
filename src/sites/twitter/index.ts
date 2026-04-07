import type { SitePlugin } from '../../registry/types.js';
import type { Primitives } from '../../primitives/types.js';
import type { Trace } from '../../trace.js';
import { twitterDetect, isLoggedIn } from './site.js';
import { checkLogin, getFeed, getTweetDetail, getSearch, follow, unfollow } from './workflows.js';
import { feedItemsToIngestItems } from './store-adapter.js';
import { TwitterFeedParamsSchema, TweetDetailParamsSchema, TwitterSearchParamsSchema, TwitterFollowActionParamsSchema, TwitterProfileParamsSchema } from './types.js';
import { getProfile } from './profile.js';
import { twitterLocalQuery } from './local-query.js';
import { twitterDisplaySchema } from './display.js';
import { canonicalizeTab } from './canonicalize.js';

export const plugin: SitePlugin = {
  apiVersion: 1,
  name: 'twitter',
  domains: ['x.com', 'twitter.com'],
  detect: twitterDetect,

  auth: {
    check: checkLogin,
    guard: isLoggedIn,
    description: 'Check if user is logged in to Twitter/X. Returns { loggedIn: boolean }.',
  },
  storeAdapter: {
    toIngestItems: feedItemsToIngestItems,
  },

  workflows: [
    {
      kind: 'collection' as const,
      name: 'feed',
      description:
        'Collect tweets from Twitter/X timeline. Supports any tab on the home page: ' +
        '"for_you" and "following" always work regardless of UI language. ' +
        'For pinned Lists or Communities, use the tab name as shown on the page ' +
        '(e.g. "vibe coding"). If the name doesn\'t match, the error lists all ' +
        'available tabs. Default: "for_you".',
      params: TwitterFeedParamsSchema,
      execute: (primitives: Primitives, params: unknown) =>
        getFeed(primitives, params as Parameters<typeof getFeed>[1]),
      cache: {
        defaultMaxAge: 120,
        variantKey: 'tab',
        defaultVariant: 'for_you',
        canonicalizeVariant: canonicalizeTab,
      },
      localQuery: twitterLocalQuery,
      dumpRaw: true,
      cli: {
        description: 'Collect tweets from the home timeline',
        help: `Options:\n  --count <n>            Number of tweets (1-100, default: 20)\n  --tab <name>           Feed tab name (default: for_you). Use exact tab name\n                         for pinned Lists/Communities. "for_you" and "following"\n                         always work regardless of language.\n  --debug                Include diagnostic info`,
      },
    },
    {
      kind: 'collection' as const,
      name: 'search',
      description:
        'Search Twitter for tweets matching a query. Supports Twitter search operators ' +
        '(from:user, min_faves:N, since:YYYY-MM-DD, filter:media, lang:en, etc.). ' +
        'Returns structured tweet data. Use "top" tab for relevance or "latest" for chronological.',
      params: TwitterSearchParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        getSearch(primitives, params as Parameters<typeof getSearch>[1], trace),
      dumpRaw: true,
      expose: ['cli'],
      cli: {
        description: 'Search tweets on Twitter',
        help: `Options:\n  --query <text>         Search query (required, supports Twitter operators)\n  --tab <name>           Search tab: top | latest (default: top)\n  --count <n>            Number of tweets (1-100, default: 20)\n  --debug                Include diagnostic info`,
      },
    },
    {
      kind: 'collection' as const,
      name: 'tweet_detail',
      description:
        'Get a tweet with its replies. Returns the original tweet (with full text) as items[0] ' +
        'and replies as items[1..n].',
      params: TweetDetailParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        getTweetDetail(primitives, params as Parameters<typeof getTweetDetail>[1], trace),
      dumpRaw: true,
      expose: ['mcp', 'cli'],
      cli: {
        description: 'Get a tweet and its replies',
        help: `Options:\n  --url <url>             Tweet URL (required)\n  --count <n>            Max replies (1-100, default: 20)\n  --debug                Include diagnostic info`,
      },
    },
    {
      kind: 'action' as const,
      name: 'follow',
      description:
        'Follow a Twitter/X user. Idempotent: safe to call if already following. ' +
        'Detects current state before acting. Daily limit enforced (50/day).',
      params: TwitterFollowActionParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        follow(primitives, params as Parameters<typeof follow>[1], trace),
      dailyLimit: 50,
      dailyLimitKey: 'follow,unfollow',
      expose: ['cli'],
      cli: {
        description: 'Follow a Twitter user',
        help: `Options:\n  --handle <user>        Twitter handle (required, with or without @)\n  --url <url>            Profile URL (alternative to --handle)\n  --debug                Include diagnostic info`,
      },
    },
    {
      kind: 'action' as const,
      name: 'unfollow',
      description:
        'Unfollow a Twitter/X user. Idempotent: safe to call if not following. ' +
        'Handles confirmation dialog. Daily limit enforced (50/day).',
      params: TwitterFollowActionParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        unfollow(primitives, params as Parameters<typeof unfollow>[1], trace),
      dailyLimit: 50,
      dailyLimitKey: 'follow,unfollow',
      expose: ['cli'],
      cli: {
        description: 'Unfollow a Twitter user',
        help: `Options:\n  --handle <user>        Twitter handle (required, with or without @)\n  --url <url>            Profile URL (alternative to --handle)\n  --debug                Include diagnostic info`,
      },
    },
    {
      kind: 'query' as const,
      name: 'profile',
      description:
        'View a Twitter/X user profile and follow relationship. ' +
        'Read-only — no side effects. Shows display name, bio, ' +
        'follower/following counts, and mutual follow status.',
      params: TwitterProfileParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        getProfile(primitives, params as Parameters<typeof getProfile>[1], trace),
      expose: ['cli'],
      cli: {
        description: 'View a user profile and follow relationship',
        help: `Options:\n  --handle <user>        Twitter handle (required, with or without @)\n  --url <url>            Profile URL (alternative to --handle)\n  --debug                Include diagnostic info`,
      },
    },
  ],

  displaySchema: twitterDisplaySchema,

  hints: {
    rateLimited:
      'Rate limited by Twitter/X. Wait at least 15 minutes before retrying. ' +
      'Do not attempt to scroll or navigate on Twitter during this time.',
    elementNotFound:
      'Expected UI element not found on Twitter/X. The page may not have loaded, ' +
      'or Twitter may have updated their UI. Try taking a screenshot to diagnose.',
  },
};
