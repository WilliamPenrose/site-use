import { describe, it, expect } from 'vitest';
import { hydrateDomSnapshot } from '../../packages/runtime/src/internal/primitives/snapshot/hydrate.js';
import type { RawDomSnapshot } from '../../packages/runtime/src/internal/primitives/snapshot/types.js';

describe('hydrateDomSnapshot', () => {
  it('empty input → empty lookup', () => {
    const result = hydrateDomSnapshot({ documents: [], strings: [] }, 1);
    expect(result.size).toBe(0);
  });

  it('single document — decodes backendNodeId, tag, attributes, parentIndex', () => {
    const snapshot: RawDomSnapshot = {
      strings: ['HTML', 'BODY', 'DIV', 'id', 'root', 'class', 'card'],
      documents: [{
        frame: 'main-frame',
        nodes: {
          parentIndex: [-1, 0, 1],
          nodeType: [1, 1, 1],
          nodeName: [0, 1, 2],
          nodeValue: [-1, -1, -1],
          backendNodeId: [10, 11, 12],
          attributes: [
            [],
            [],
            [3, 4, 5, 6],
          ],
          isClickable: { index: [] },
        },
        layout: { nodeIndex: [], bounds: [], styles: [] },
      }],
    };
    const result = hydrateDomSnapshot(snapshot, 1);

    expect(result.size).toBe(3);
    const div = result.get(12)!;
    expect(div.backendNodeId).toBe(12);
    expect(div.tag).toBe('div');
    expect(div.attributes).toEqual({ id: 'root', class: 'card' });
    expect(div.parentBackendNodeId).toBe(11);
    expect(div.frameId).toBe('main-frame');
    expect(div.nodeType).toBe(1);

    const html = result.get(10)!;
    expect(html.parentBackendNodeId).toBeNull();
  });

  it('decodes isClickable RareBooleanData (sparse hits)', () => {
    const snapshot: RawDomSnapshot = {
      strings: ['DIV'],
      documents: [{
        frame: 'main',
        nodes: {
          parentIndex: [-1, 0, 0, 0],
          nodeType: [1, 1, 1, 1],
          nodeName: [0, 0, 0, 0],
          nodeValue: [-1, -1, -1, -1],
          backendNodeId: [1, 2, 3, 4],
          attributes: [[], [], [], []],
          isClickable: { index: [1, 3] },
        },
        layout: { nodeIndex: [], bounds: [], styles: [] },
      }],
    };
    const result = hydrateDomSnapshot(snapshot, 1);
    expect(result.get(1)!.isClickable).toBe(false);
    expect(result.get(2)!.isClickable).toBe(true);
    expect(result.get(3)!.isClickable).toBe(false);
    expect(result.get(4)!.isClickable).toBe(true);
  });

  it('decodes layout bounds with devicePixelRatio scaling and cursor style', () => {
    const snapshot: RawDomSnapshot = {
      strings: ['DIV', 'pointer'],
      documents: [{
        frame: 'main',
        nodes: {
          parentIndex: [-1],
          nodeType: [1],
          nodeName: [0],
          nodeValue: [-1],
          backendNodeId: [99],
          attributes: [[]],
          isClickable: { index: [] },
        },
        layout: {
          nodeIndex: [0],
          bounds: [[100, 200, 300, 400]],
          styles: [[1]],
        },
      }],
    };
    const result = hydrateDomSnapshot(snapshot, 2);
    const entry = result.get(99)!;
    expect(entry.bounds).toEqual({ x: 50, y: 100, width: 150, height: 200 });
    expect(entry.cursorStyle).toBe('pointer');
  });
});
