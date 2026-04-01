import { describe, it, expect } from 'vitest';
import type { SnapshotNode } from '../../src/primitives/types.js';
import { matchByRule, matchAllByRule, findByDescriptor, meetsCondition } from '../../src/ops/matchers.js';
import { buildSnapshot } from '../../src/testing/index.js';

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

describe('findByDescriptor', () => {
  it('finds node matching role and string name', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following' },
      { uid: '2', role: 'tab', name: 'For you' },
    ]);
    const result = findByDescriptor(snapshot, { role: 'tab', name: 'Following' });
    expect(result).not.toBeNull();
    expect(result!.uid).toBe('1');
  });

  it('finds node matching role and regex name', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'tab', name: 'Following' },
    ]);
    const result = findByDescriptor(snapshot, { role: 'tab', name: /follow/i });
    expect(result).not.toBeNull();
    expect(result!.uid).toBe('1');
  });

  it('returns null when no match', () => {
    const snapshot = buildSnapshot([
      { uid: '1', role: 'button', name: 'Post' },
    ]);
    expect(findByDescriptor(snapshot, { role: 'tab', name: 'Following' })).toBeNull();
  });

  it('throws when role is missing from descriptor', () => {
    const snapshot = buildSnapshot([]);
    expect(() => findByDescriptor(snapshot, { name: 'Following' })).toThrow();
  });
});

describe('meetsCondition', () => {
  it('returns true when selected matches', () => {
    const node: SnapshotNode = { uid: '1', role: 'tab', name: 'Following', selected: true };
    expect(meetsCondition(node, { role: 'tab', name: 'Following', selected: true })).toBe(true);
  });

  it('returns false when selected does not match', () => {
    const node: SnapshotNode = { uid: '1', role: 'tab', name: 'Following', selected: false };
    expect(meetsCondition(node, { role: 'tab', name: 'Following', selected: true })).toBe(false);
  });

  it('returns true when expanded matches', () => {
    const node: SnapshotNode = { uid: '1', role: 'button', name: 'Menu', expanded: true };
    expect(meetsCondition(node, { role: 'button', name: 'Menu', expanded: true })).toBe(true);
  });

  it('returns false when expanded does not match', () => {
    const node: SnapshotNode = { uid: '1', role: 'button', name: 'Menu', expanded: false };
    expect(meetsCondition(node, { role: 'button', name: 'Menu', expanded: true })).toBe(false);
  });

  it('returns true when no state fields specified (existence only)', () => {
    const node: SnapshotNode = { uid: '1', role: 'tab', name: 'Following' };
    expect(meetsCondition(node, { role: 'tab', name: 'Following' })).toBe(true);
  });

  it('throws when checked is specified (not implemented)', () => {
    const node: SnapshotNode = { uid: '1', role: 'checkbox', name: 'Agree' };
    expect(() => meetsCondition(node, { role: 'checkbox', name: 'Agree', checked: true })).toThrow(/not implemented/i);
  });

  it('throws when value is specified (not implemented)', () => {
    const node: SnapshotNode = { uid: '1', role: 'combobox', name: 'Region' };
    expect(() => meetsCondition(node, { role: 'combobox', name: 'Region', value: 'Asia' })).toThrow(/not implemented/i);
  });
});
