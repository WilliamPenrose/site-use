import { describe, it, expect } from 'vitest';
import type { Snapshot, SnapshotNode } from '../../src/primitives/types.js';
import { matchByRule, matchAllByRule } from '../../src/ops/matchers.js';

function buildSnapshot(nodes: SnapshotNode[]): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) idToNode.set(node.uid, node);
  return { idToNode };
}

describe('matchByRule', () => {
  it('returns uid when role and exact name match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Post' },
    ]);
    expect(matchByRule(snapshot, { role: 'link', name: 'Home' })).toBe('1');
  });

  it('returns uid when name matches regex', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'home' },
    ]);
    expect(matchByRule(snapshot, { role: 'link', name: /^home$/i })).toBe('1');
  });

  it('returns null when no match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Settings' },
    ]);
    expect(matchByRule(snapshot, { role: 'link', name: 'Home' })).toBeNull();
  });
});

describe('matchAllByRule', () => {
  it('returns all matching uids', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'link', name: 'Home' },
      { uid: '2', role: 'button', name: 'Post' },
      { uid: '3', role: 'link', name: 'HOME' },
    ]);
    expect(matchAllByRule(snapshot, { role: 'link', name: /^home$/i })).toEqual(['1', '3']);
  });

  it('returns empty array when no match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Post' },
    ]);
    expect(matchAllByRule(snapshot, { role: 'link', name: 'Home' })).toEqual([]);
  });
});
