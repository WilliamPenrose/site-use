import { describe, it, expect } from 'vitest';
import type { Snapshot, SnapshotNode } from '../../src/primitives/types.js';
import {
  matchByRule,
  matchAllByRule,
  rules,
} from '../../src/sites/twitter/matchers.js';

function buildSnapshot(nodes: SnapshotNode[]): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) {
    idToNode.set(node.uid, node);
  }
  return { idToNode };
}

describe('matchByRule', () => {
  it('returns uid when role and exact name match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Post' },
    ]);
    expect(matchByRule(snapshot, rules.homeNavLink)).toBe('1');
  });

  it('returns uid when name matches regex (case insensitive)', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'home' },
    ]);
    expect(matchByRule(snapshot, rules.homeNavLink)).toBe('1');
  });

  it('returns null when no match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Settings' },
    ]);
    expect(matchByRule(snapshot, rules.homeNavLink)).toBeNull();
  });

  it('returns null when role matches but name does not', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Explore' },
    ]);
    expect(matchByRule(snapshot, rules.homeNavLink)).toBeNull();
  });

  it('matches tweetComposeButton rule', () => {
    const snapshot = buildSnapshot([
      { uid: '5', role: 'link', name: 'Compose post' },
    ]);
    expect(matchByRule(snapshot, rules.tweetComposeButton)).toBe('5');
  });
});

describe('matchAllByRule', () => {
  it('returns all matching uids', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Post' },
      { uid: '3', role: 'link', name: 'HOME' },
    ]);
    const result = matchAllByRule(snapshot, rules.homeNavLink);
    expect(result).toEqual(['1', '3']);
  });

  it('returns empty array when no match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Post' },
    ]);
    expect(matchAllByRule(snapshot, rules.homeNavLink)).toEqual([]);
  });
});
