import { describe, it, expect } from 'vitest';
import { mergeAXData } from '../../src/primitives/snapshot/merge.js';
import type { RawFrameAX } from '../../src/primitives/snapshot/types.js';

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
        axNode('a1', 'button', 'OK'), // backendDOMNodeId is null
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.nodes).toHaveLength(1);
    expect(result.uidToBackendNodeId.has('1')).toBe(false);
  });

  it('preserves axIdToUid mapping for children resolution', () => {
    const data: RawFrameAX[] = [
      { frameId: 'main', frameUrl: 'https://example.com', isMainFrame: true, nodes: [
        axNode('a1', 'navigation', 'Nav', 100, { childIds: ['a2'] }),
        axNode('a2', 'link', 'Home', 101),
      ]},
    ];

    const result = mergeAXData(data);

    expect(result.axIdToUid.get('a1')).toBe('1');
    expect(result.axIdToUid.get('a2')).toBe('2');
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
