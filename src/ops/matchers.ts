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

export interface StateDescriptor {
  url?: string | RegExp;
  role?: string;
  name?: string | RegExp;
  selected?: boolean;
  expanded?: boolean;
  /** Not implemented in M2 — throws at runtime if used. */
  checked?: boolean;
  /** Not implemented in M2 — throws at runtime if used. */
  value?: string;
}

/**
 * Find element matching role+name from a StateDescriptor.
 * Requires `role` to be present. Returns the SnapshotNode (which includes uid) or null.
 */
export function findByDescriptor(
  snapshot: Snapshot,
  desc: StateDescriptor,
): SnapshotNode | null {
  if (!desc.role) {
    throw new Error('findByDescriptor requires role in descriptor');
  }
  const rule: MatcherRule = { role: desc.role, name: desc.name ?? /.*/ };
  for (const [, node] of snapshot.idToNode) {
    if (matchesRule(node, rule)) return node;
  }
  return null;
}

/**
 * Check if a node's state fields match the descriptor.
 * M2 supports: selected, expanded. checked/value throw if specified.
 */
export function meetsCondition(
  node: SnapshotNode,
  desc: StateDescriptor,
): boolean {
  if (desc.checked !== undefined) {
    throw new Error('StateDescriptor.checked is not implemented in M2');
  }
  if (desc.value !== undefined) {
    throw new Error('StateDescriptor.value is not implemented in M2');
  }
  if (desc.selected !== undefined && node.selected !== desc.selected) return false;
  if (desc.expanded !== undefined && node.expanded !== desc.expanded) return false;
  return true;
}
