import type { RawFrameAX, MergedNode } from './types.js';

export interface MergeResult {
  nodes: MergedNode[];
  uidToBackendNodeId: Map<string, number>;
  axIdToUid: Map<string, string>;
}

function shouldSkipNode(node: any): boolean {
  if (node.ignored) return true;
  const role = node.role?.value;
  if (role === 'none' || role === 'Ignored') return true;
  return false;
}

/**
 * Merge multi-frame AX data into a flat list of MergedNodes.
 * Assigns sequential uids, populates uidToBackendNodeId, filters ignored nodes.
 * First frame in the array is treated as the main frame (frameUrl = undefined).
 */
export function mergeAXData(rawData: RawFrameAX[]): MergeResult {
  const nodes: MergedNode[] = [];
  const uidToBackendNodeId = new Map<string, number>();
  const axIdToUid = new Map<string, string>();
  let nextUid = 1;

  for (const frame of rawData) {
    for (const axNode of frame.nodes) {
      if (shouldSkipNode(axNode)) continue;

      const uid = String(nextUid++);
      // Scope by frameId to prevent cross-frame nodeId collisions.
      // CDP does not guarantee globally unique AX nodeIds across frames.
      axIdToUid.set(`${frame.frameId}:${axNode.nodeId}`, uid);

      if (axNode.backendDOMNodeId != null) {
        uidToBackendNodeId.set(uid, axNode.backendDOMNodeId);
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

  return { nodes, uidToBackendNodeId, axIdToUid };
}
