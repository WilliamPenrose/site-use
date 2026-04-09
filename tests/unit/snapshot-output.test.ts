import { describe, it, expect } from 'vitest';
import { buildSnapshotOutput } from '../../src/primitives/snapshot/output.js';
import type { MergedNode } from '../../src/primitives/snapshot/types.js';

const DEFAULT_FRAME = 'main';

function mergedNode(uid: string, role: string, name: string, opts?: {
  frameId?: string;
  frameUrl?: string;
  value?: any;
  properties?: any[];
  childIds?: string[];
}): MergedNode {
  return {
    uid,
    axNode: {
      nodeId: `ax-${uid}`,
      role: { value: role },
      name: { value: name },
      value: opts?.value != null ? { value: opts.value } : undefined,
      properties: opts?.properties ?? [],
      childIds: opts?.childIds,
    },
    backendNodeId: null,
    frameId: opts?.frameId ?? DEFAULT_FRAME,
    frameUrl: opts?.frameUrl,
  };
}

describe('buildSnapshotOutput', () => {
  it('builds SnapshotNode with role, name, uid', () => {
    const axIdToUid = new Map([['main:ax-1', '1']]);
    const snapshot = buildSnapshotOutput([mergedNode('1', 'button', 'OK')], axIdToUid);

    const node = snapshot.idToNode.get('1');
    expect(node).toBeDefined();
    expect(node!.role).toBe('button');
    expect(node!.name).toBe('OK');
    expect(node!.uid).toBe('1');
  });

  it('sets frameUrl for iframe nodes, omits for main frame', () => {
    const nodes = [
      mergedNode('1', 'button', 'Main'),
      mergedNode('2', 'button', 'InFrame', { frameUrl: 'https://example.com/form' }),
    ];
    const axIdToUid = new Map([['main:ax-1', '1'], ['main:ax-2', '2']]);
    const snapshot = buildSnapshotOutput(nodes, axIdToUid);

    expect(snapshot.idToNode.get('1')!.frameUrl).toBeUndefined();
    expect(snapshot.idToNode.get('2')!.frameUrl).toBe('https://example.com/form');
  });

  it('extracts optional properties (disabled, focused, expanded, selected, level)', () => {
    const nodes = [mergedNode('1', 'button', 'Save', {
      properties: [
        { name: 'disabled', value: { value: true } },
        { name: 'focused', value: { value: true } },
        { name: 'expanded', value: { value: false } },
        { name: 'selected', value: { value: true } },
        { name: 'level', value: { value: 3 } },
      ],
    })];
    const snapshot = buildSnapshotOutput(nodes, new Map([['main:ax-1', '1']]));

    const node = snapshot.idToNode.get('1')!;
    expect(node.disabled).toBe(true);
    expect(node.focused).toBe(true);
    expect(node.expanded).toBe(false);
    expect(node.selected).toBe(true);
    expect(node.level).toBe(3);
  });

  it('extracts value for form elements', () => {
    const nodes = [mergedNode('1', 'textbox', 'Email', { value: 'a@b.com' })];
    const snapshot = buildSnapshotOutput(nodes, new Map([['main:ax-1', '1']]));

    expect(snapshot.idToNode.get('1')!.value).toBe('a@b.com');
  });

  it('resolves children within the same frame', () => {
    const nodes = [
      mergedNode('1', 'navigation', 'Nav', { childIds: ['ax-2', 'ax-3'] }),
      mergedNode('2', 'link', 'Home'),
      mergedNode('3', 'link', 'Profile'),
    ];
    const axIdToUid = new Map([['main:ax-1', '1'], ['main:ax-2', '2'], ['main:ax-3', '3']]);
    const snapshot = buildSnapshotOutput(nodes, axIdToUid);

    expect(snapshot.idToNode.get('1')!.children).toEqual(['2', '3']);
  });

  it('omits children array when no valid children exist', () => {
    const nodes = [mergedNode('1', 'button', 'OK', { childIds: ['ax-gone'] })];
    const axIdToUid = new Map([['main:ax-1', '1']]);
    const snapshot = buildSnapshotOutput(nodes, axIdToUid);

    expect(snapshot.idToNode.get('1')!.children).toBeUndefined();
  });

  it('does not cross frame boundaries for children', () => {
    // Parent in main frame has childId pointing to ax-2,
    // but ax-2 doesn't exist in the main frame (it's in a different frame)
    const nodes = [
      mergedNode('1', 'navigation', 'Nav', { childIds: ['ax-2'] }),
      // Node from iframe has its own ax nodeId 'bx-1', not 'ax-2'
      mergedNode('2', 'button', 'Submit', { frameId: 'iframe-1', frameUrl: 'https://example.com/form' }),
    ];
    // Keys are scoped by frameId — main:ax-2 doesn't exist, iframe-1:ax-2 is a different key
    const axIdToUid = new Map([['main:ax-1', '1'], ['iframe-1:ax-2', '2']]);
    const snapshot = buildSnapshotOutput(nodes, axIdToUid);

    // main frame's childId 'ax-2' resolves to 'main:ax-2' which is not in the map
    expect(snapshot.idToNode.get('1')!.children).toBeUndefined();
  });
});
