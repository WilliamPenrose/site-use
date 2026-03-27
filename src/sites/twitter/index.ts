import type { SitePlugin } from '../../registry/types.js';
import type { Primitives } from '../../primitives/types.js';
import { twitterDetect, isLoggedIn } from './site.js';
import { checkLogin, getFeed } from './workflows.js';
import { feedItemsToIngestItems } from './store-adapter.js';
import { TwitterFeedParamsSchema } from './types.js';
import { twitterLocalQuery } from './local-query.js';

export const plugin: SitePlugin = {
  apiVersion: 1,
  name: 'twitter',
  domains: ['x.com', 'twitter.com'],
  detect: twitterDetect,

  capabilities: {
    auth: {
      check: checkLogin,
      guard: isLoggedIn,  // returns { loggedIn, diagnostics }
      description: 'Check if user is logged in to Twitter/X. Returns { loggedIn: boolean }.',
    },
    feed: {
      collect: (primitives: Primitives, params: unknown) =>
        getFeed(primitives, params as Parameters<typeof getFeed>[1]),
      params: TwitterFeedParamsSchema,
      localQuery: twitterLocalQuery,
      cache: {
        defaultMaxAge: 120,
        variantKey: 'tab',
        defaultVariant: 'for_you',
      },
      description:
        'Collect tweets from Twitter/X timeline. Supports "following" (chronological) ' +
        'and "for_you" (algorithmic) tabs. Returns structured tweet data with metrics, ' +
        'media, and thread context.',
      cli: {
        description: 'Collect tweets from the home timeline',
        help: `Options:\n  --count <n>            Number of tweets (1-100, default: 20)\n  --tab <name>           Feed tab: following | for_you (default: for_you)\n  --debug                Include diagnostic info`,
      },
    },
  },

  storeAdapter: {
    toIngestItems: feedItemsToIngestItems,
  },

  hints: {
    sessionExpired:
      'User is not logged in to Twitter/X. Ask the user to open the browser, ' +
      'navigate to x.com, and log in manually. Then retry.',
    rateLimited:
      'Rate limited by Twitter/X. Wait at least 15 minutes before retrying. ' +
      'Do not attempt to scroll or navigate on Twitter during this time.',
    elementNotFound:
      'Expected UI element not found on Twitter/X. The page may not have loaded, ' +
      'or Twitter may have updated their UI. Try taking a screenshot to diagnose.',
  },
};
