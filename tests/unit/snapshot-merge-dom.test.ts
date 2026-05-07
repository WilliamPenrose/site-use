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
