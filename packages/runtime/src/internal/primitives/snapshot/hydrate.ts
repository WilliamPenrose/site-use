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

      const entry: DomEntry = {
        backendNodeId,
        frameId: doc.frame ?? '',
        parentBackendNodeId,
        tag,
        attributes: attrs,
        bounds: null,
        cursorStyle: null,
        isClickable: false,
        nodeType: nodes.nodeType?.[i] ?? 0,
        nodeValue,
      };
      lookup.set(backendNodeId, entry);
    }
  }

  return lookup;
}
