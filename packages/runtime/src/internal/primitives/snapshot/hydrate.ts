import type { RawFrameAX, RawDomSnapshot, DomLookup, DomEntry } from './types.js';

/** AX hydrate (M1): passthrough. */
export function hydrateAXData(rawData: RawFrameAX[]): RawFrameAX[] {
  return rawData;
}

/**
 * Decode CDP DOMSnapshot SoA into a backendNodeId-indexed lookup.
 * Each DocumentSnapshot represents one frame; documents are merged into one lookup
 * because backendNodeId is globally unique across same-origin documents.
 */
export function hydrateDomSnapshot(
  snapshot: RawDomSnapshot,
  devicePixelRatio: number,
): DomLookup {
  const lookup: DomLookup = new Map();
  const strings = snapshot.strings;

  for (const doc of snapshot.documents) {
    const nodes = doc.nodes;
    const backendIds: number[] = nodes.backendNodeId ?? [];
    if (backendIds.length === 0) continue;

    const indexToBackendId: number[] = backendIds;

    // Pre-build set for O(1) isClickable lookup (RareBooleanData stores indices)
    const clickableSet = new Set<number>(nodes.isClickable?.index ?? []);

    // Pre-build layout-index map (nodeIndex → layout entry index)
    const layout = doc.layout ?? {};
    const layoutNodeIndex: number[] = layout.nodeIndex ?? [];
    const layoutIndexMap = new Map<number, number>();
    for (let li = 0; li < layoutNodeIndex.length; li++) {
      const nodeIdx = layoutNodeIndex[li];
      if (!layoutIndexMap.has(nodeIdx)) layoutIndexMap.set(nodeIdx, li);
    }

    for (let i = 0; i < backendIds.length; i++) {
      const backendNodeId = backendIds[i];
      const tagStrIdx = nodes.nodeName?.[i];
      const tag = (typeof tagStrIdx === 'number' && tagStrIdx >= 0 && tagStrIdx < strings.length)
        ? strings[tagStrIdx].toLowerCase() : '';

      const attrs: Record<string, string> = {};
      const attrIndices = nodes.attributes?.[i] ?? [];
      for (let a = 0; a + 1 < attrIndices.length; a += 2) {
        const nameIdx = attrIndices[a];
        const valueIdx = attrIndices[a + 1];
        if (nameIdx < 0 || nameIdx >= strings.length) continue;
        const value = (valueIdx >= 0 && valueIdx < strings.length) ? strings[valueIdx] : '';
        attrs[strings[nameIdx]] = value;
      }

      const parentIdx = nodes.parentIndex?.[i] ?? -1;
      const parentBackendNodeId = (parentIdx >= 0 && parentIdx < indexToBackendId.length)
        ? indexToBackendId[parentIdx] : null;

      const nodeValueIdx = nodes.nodeValue?.[i] ?? -1;
      const nodeValue = (nodeValueIdx >= 0 && nodeValueIdx < strings.length)
        ? strings[nodeValueIdx] : null;

      // Layout data (bounds + cursor) if this node has a layout entry
      let bounds: DomEntry['bounds'] = null;
      let cursorStyle: string | null = null;
      const layoutIdx = layoutIndexMap.get(i);
      if (layoutIdx != null) {
        const rawBounds = layout.bounds?.[layoutIdx];
        if (rawBounds && rawBounds.length >= 4) {
          bounds = {
            x: rawBounds[0] / devicePixelRatio,
            y: rawBounds[1] / devicePixelRatio,
            width: rawBounds[2] / devicePixelRatio,
            height: rawBounds[3] / devicePixelRatio,
          };
        }
        const styleIndices: number[] | undefined = layout.styles?.[layoutIdx];
        if (styleIndices && styleIndices.length > 0) {
          const cursorIdx = styleIndices[0];
          if (cursorIdx >= 0 && cursorIdx < strings.length) {
            cursorStyle = strings[cursorIdx];
          }
        }
      }

      const isClickable = clickableSet.has(i);

      const entry: DomEntry = {
        backendNodeId,
        frameId: doc.frame ?? '',
        parentBackendNodeId,
        tag,
        attributes: attrs,
        bounds,
        cursorStyle,
        isClickable,
        nodeType: nodes.nodeType?.[i] ?? 0,
        nodeValue,
      };
      lookup.set(backendNodeId, entry);
    }
  }

  return lookup;
}
