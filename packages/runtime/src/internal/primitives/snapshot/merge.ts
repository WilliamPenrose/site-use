import type { RawFrameAX, MergedNode, MergeResult } from './types.js';

function shouldSkipNode(node: any): boolean {
  if (node.ignored) return true;
  const role = node.role?.value;
  if (role === 'none' || role === 'Ignored') return true;
  return false;
}

/**
 * Merge multi-frame AX data into a flat list of MergedNodes.
 * Now also returns reverse indexes (axNodeByBackendId, backendIdToUid)
 * for M2 cross-join with DOMSnapshot.
 */
export function mergeAxData(rawData: RawFrameAX[]): MergeResult {
  const nodes: MergedNode[] = [];
  const uidToBackendNodeId = new Map<string, number>();
  const axIdToUid = new Map<string, string>();
  const axNodeByBackendId = new Map<number, any>();
  const backendIdToUid = new Map<number, string>();
  let nextUid = 1;

  for (const frame of rawData) {
    for (const axNode of frame.nodes) {
      if (shouldSkipNode(axNode)) continue;

      const uid = String(nextUid++);
      axIdToUid.set(`${frame.frameId}:${axNode.nodeId}`, uid);

      if (axNode.backendDOMNodeId != null) {
        uidToBackendNodeId.set(uid, axNode.backendDOMNodeId);
        axNodeByBackendId.set(axNode.backendDOMNodeId, axNode);
        backendIdToUid.set(axNode.backendDOMNodeId, uid);
      }

      nodes.push({
        uid,
        axNode,
        backendNodeId: axNode.backendDOMNodeId ?? null,
        frameId: frame.frameId,
        frameUrl: frame.isMainFrame ? undefined : frame.frameUrl,
      });
    }
  }

  return { nodes, uidToBackendNodeId, axIdToUid, axNodeByBackendId, backendIdToUid };
}
