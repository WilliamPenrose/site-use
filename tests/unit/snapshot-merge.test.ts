import { describe, it, expect } from 'vitest';
import { mergeAXData } from '../../packages/runtime/src/internal/primitives/snapshot/merge.js';
import type { RawFrameAX } from '../../packages/runtime/src/internal/primitives/snapshot/types.js';

function axNode(nodeId: string, role: string, name: string, backendDOMNodeId?: number, extra?: any) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    backendDOMNodeId: backendDOMNodeId ?? null,
    ignored: false,
    properties: [],
    ...extra,
  };
}

describe('mergeAXData', () => {
  it('assigns sequential uids across frames', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [axNode('a1', 'button', 'OK', 100)] },
      { frameId: 'iframe', frameUrl: 'https://example.com/form', isMainFrame: false, nodes: [axNode('b1', 'textbox', 'Name', 200)] },
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].uid).toBe('1');
    expect(result.nodes[1].uid).toBe('2');
  });

  it('sets frameUrl only for iframe nodes, undefined for main frame', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [axNode('a1', 'button', 'OK', 100)] },
      { frameId: 'iframe', frameUrl: 'https://example.com/form', isMainFrame: false, nodes: [axNode('b1', 'textbox', 'Name', 200)] },
    ];

    const result = mergeAXData(data);

    expect(result.nodes[0].frameUrl).toBeUndefined();
    expect(result.nodes[1].frameUrl).toBe('https://example.com/form');
  });

  it('populates uidToBackendNodeId map', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [
        axNode('a1', 'button', 'OK', 101),
        axNode('a2', 'link', 'Home', 102),
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.uidToBackendNodeId.get('1')).toBe(101);
    expect(result.uidToBackendNodeId.get('2')).toBe(102);
  });

  it('skips ignored nodes', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [
        { nodeId: 'x', role: { value: 'none' }, name: { value: '' }, ignored: true, properties: [] },
        axNode('a1', 'button', 'OK', 101),
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].uid).toBe('1');
  });

  it('skips nodes with role=none or role=Ignored', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [
        axNode('x1', 'none', '', 100),
        axNode('x2', 'Ignored', '', 101),
        axNode('a1', 'button', 'OK', 102),
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(1);
  });

  it('handles nodes without backendDOMNodeId', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [
        axNode('a1', 'button', 'OK'),
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(1);
    expect(result.uidToBackendNodeId.has('1')).toBe(false);
  });

  it('scopes axIdToUid by frameId to prevent cross-frame collisions', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [axNode('a1', 'button', 'OK', 100)] },
      { frameId: 'iframe', frameUrl: 'https://example.com/form', isMainFrame: false, nodes: [axNode('a1', 'textbox', 'Name', 200)] },
    ];

    const result = mergeAXData(data);

    // Same nodeId 'a1' in different frames should map to different uids
    expect(result.axIdToUid.get('main:a1')).toBe('1');
    expect(result.axIdToUid.get('iframe:a1')).toBe('2');
  });

  it('handles empty frame (no nodes)', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [axNode('a1', 'button', 'OK', 100)] },
      { frameId: 'empty', frameUrl: 'https://example.com/empty', isMainFrame: false, nodes: [] },
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(1);
  });
});
