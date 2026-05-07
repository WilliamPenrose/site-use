import { describe, it, expect } from 'vitest';
import { mergeAxData, mergeDomSnapshot } from '../../packages/runtime/src/internal/primitives/snapshot/merge.js';
import type { DomEntry, DomLookup, RawFrameAX } from '../../packages/runtime/src/internal/primitives/snapshot/types.js';

function ax(nodeId: string, role: string, name: string, backendId: number): any {
  return { nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId: backendId, ignored: false, properties: [] };
}
function dom(p: Partial<DomEntry>): DomEntry {
  return {
    backendNodeId: 1, frameId: 'main', parentBackendNodeId: null,
    tag: 'div', attributes: {}, bounds: null, cursorStyle: null,
    isClickable: false, nodeType: 1, nodeValue: null, ...p,
  };
}

describe('mergeDomSnapshot — upgrade scenario', () => {
  it('upgrades AX role=generic node when DOM is interactive (cursor:pointer)', () => {
    const frames: RawFrameAX[] = [{
      frameId: 'main', frameUrl: 'https://x.com', isMainFrame: true,
      nodes: [ax('a1', 'generic', '', 100)],
    }];
    const base = mergeAxData(frames);

    const domLookup: DomLookup = new Map();
    const text = dom({ backendNodeId: 200, parentBackendNodeId: 100, nodeType: 3, nodeValue: '页面价 ▾' });
    const div  = dom({ backendNodeId: 100, tag: 'div', cursorStyle: 'pointer' });
    domLookup.set(100, div); domLookup.set(200, text);

    const result = mergeDomSnapshot(
      base, domLookup,
      new Map([['main', 'https://x.com']]),
      'main',
    );

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].uid).toBe('1');
    expect(result.nodes[0].upgrade).toEqual({ role: 'button', name: '页面价 ▾' });
  });
});

describe('mergeDomSnapshot — inject scenarios', () => {
  it('injects new node when AX never saw the backendNodeId (case ②)', () => {
    const frames: RawFrameAX[] = [{
      frameId: 'main', frameUrl: 'https://x.com', isMainFrame: true,
      nodes: [ax('a1', 'button', 'Existing', 100)],
    }];
    const base = mergeAxData(frames);

    const domLookup: DomLookup = new Map();
    const div = dom({ backendNodeId: 999, tag: 'div', cursorStyle: 'pointer' });
    const text = dom({ backendNodeId: 1000, parentBackendNodeId: 999, nodeType: 3, nodeValue: 'Orphan' });
    domLookup.set(999, div); domLookup.set(1000, text);

    const result = mergeDomSnapshot(
      base, domLookup,
      new Map([['main', 'https://x.com']]),
      'main',
    );

    expect(result.nodes.length).toBe(2);
    const injected = result.nodes.find(n => n.axNode === null)!;
    expect(injected.uid).toBe('2');
    expect(injected.backendNodeId).toBe(999);
    expect(injected.frameUrl).toBeUndefined();
    expect(injected.inferred).toEqual({ role: 'button', name: 'Orphan' });
    expect(result.uidToBackendNodeId.get('2')).toBe(999);
  });

  it('injects when AX dropped node via shouldSkipNode (case ③)', () => {
    const frames: RawFrameAX[] = [{
      frameId: 'main', frameUrl: 'https://x.com', isMainFrame: true,
      nodes: [
        { nodeId: 'a1', role: { value: 'none' }, name: { value: '' }, backendDOMNodeId: 500, ignored: false, properties: [] },
      ],
    }];
    const base = mergeAxData(frames);
    expect(base.nodes.length).toBe(0);

    const domLookup: DomLookup = new Map();
    domLookup.set(500, dom({ backendNodeId: 500, tag: 'div', cursorStyle: 'pointer' }));

    const result = mergeDomSnapshot(
      base, domLookup,
      new Map([['main', 'https://x.com']]),
      'main',
    );

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].axNode).toBeNull();
    expect(result.nodes[0].backendNodeId).toBe(500);
    expect(result.nodes[0].inferred?.role).toBe('button');
  });

  it('does not modify or duplicate existing AX role=button nodes', () => {
    const frames: RawFrameAX[] = [{
      frameId: 'main', frameUrl: 'https://x.com', isMainFrame: true,
      nodes: [ax('a1', 'button', 'Submit', 100)],
    }];
    const base = mergeAxData(frames);

    const domLookup: DomLookup = new Map();
    domLookup.set(100, dom({ backendNodeId: 100, tag: 'button', cursorStyle: 'pointer' }));

    const result = mergeDomSnapshot(
      base, domLookup,
      new Map([['main', 'https://x.com']]),
      'main',
    );

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].upgrade).toBeUndefined();
    expect(result.nodes[0].inferred).toBeUndefined();
    expect(result.nodes[0].axNode.role.value).toBe('button');
  });

  it('injected iframe-internal node has correct frameUrl', () => {
    const frames: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://x.com', isMainFrame: true, nodes: [] },
      { frameId: 'iframe-1', frameUrl: 'https://x.com/dialog', isMainFrame: false, nodes: [] },
    ];
    const base = mergeAxData(frames);

    const domLookup: DomLookup = new Map();
    domLookup.set(700, dom({ backendNodeId: 700, frameId: 'iframe-1', tag: 'div', cursorStyle: 'pointer' }));

    const result = mergeDomSnapshot(
      base, domLookup,
      new Map([['main', 'https://x.com'], ['iframe-1', 'https://x.com/dialog']]),
      'main',
    );

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].frameUrl).toBe('https://x.com/dialog');
  });
});
