export { matchByRule, matchAllByRule, matchesRule } from '../../ops/matchers.js';
export type { MatcherRule } from '../../ops/matchers.js';
import type { MatcherRule } from '../../ops/matchers.js';

/**
 * M1 ARIA matching rules for Twitter.
 * Twitter UI changes only require updating rules here.
 */
export const rules = {
  /** Logged-in users have a Home navigation link */
  homeNavLink: {
    role: 'link',
    name: /^Home$/i,
  },
  /** Compose button only visible when logged in */
  tweetComposeButton: {
    role: 'link',
    name: /compose/i,
  },
} as const satisfies Record<string, MatcherRule>;
