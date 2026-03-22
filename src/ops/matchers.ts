import type { Snapshot, SnapshotNode } from '../primitives/types.js';

export interface MatcherRule {
  role: string;
  name: string | RegExp;
}

export function matchesRule(node: SnapshotNode, rule: MatcherRule): boolean {
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
