import type { Snapshot, SnapshotNode } from '../../primitives/types.js';

export interface MatcherRule {
  role: string;
  name: string | RegExp;
}

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

function matchesRule(node: SnapshotNode, rule: MatcherRule): boolean {
  if (node.role !== rule.role) return false;
  if (typeof rule.name === 'string') {
    return node.name === rule.name;
  }
  return rule.name.test(node.name);
}

/** Return first matching uid, or null. */
export function matchByRule(snapshot: Snapshot, rule: MatcherRule): string | null {
  for (const [uid, node] of snapshot.idToNode) {
    if (matchesRule(node, rule)) return uid;
  }
  return null;
}

/** Return all matching uids. */
export function matchAllByRule(snapshot: Snapshot, rule: MatcherRule): string[] {
  const results: string[] = [];
  for (const [uid, node] of snapshot.idToNode) {
    if (matchesRule(node, rule)) results.push(uid);
  }
  return results;
}
