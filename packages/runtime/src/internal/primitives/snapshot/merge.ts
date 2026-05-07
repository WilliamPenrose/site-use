import type { RawFrameAX, MergedNode, MergeResult, DomLookup } from './types.js';
import { ClickableElementDetector } from './clickable-detector.js';
import { deriveDomName } from './derive-name.js';

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

/**
 * Cross-join AX-merged nodes with hydrated DOMSnapshot.
 * For each DOM node the detector marks interactive:
 *   - upgrade existing AX MergedNode (role generic/'' → button) — case ①
 *   - inject new MergedNode for AX-orphan (cases ② AX never saw it; ③ AX shouldSkip dropped it)
 *     [inject branch is filled in Task 15]
 */
export function mergeDomSnapshot(
  base: MergeResult,
  domLookup: DomLookup,
  frameUrlByFrameId: Map<string, string>,
  mainFrameId: string,
): MergeResult {
  const upgraded = new Map<string, { role: string; name: string }>();
  const injected: MergedNode[] = [];

  let maxUid = 0;
  for (const n of base.nodes) {
    const num = Number(n.uid);
    if (Number.isFinite(num) && num > maxUid) maxUid = num;
  }
  let nextUid = maxUid + 1;
  const finalUidToBackendNodeId = new Map(base.uidToBackendNodeId);

  for (const [backendId, entry] of domLookup) {
    if (entry.nodeType !== 1) continue;
    const axNode = base.axNodeByBackendId.get(backendId) ?? null;
    if (!ClickableElementDetector.isInteractive(entry, axNode, domLookup)) continue;

    const inferredName = deriveDomName(entry, domLookup);
    const existingUid = base.backendIdToUid.get(backendId);

    if (existingUid != null) {
      const existing = base.nodes.find(n => n.uid === existingUid);
      const role = existing?.axNode?.role?.value ?? '';
      if (role === 'generic' || role === '' || role === 'none') {
        upgraded.set(existingUid, { role: 'button', name: inferredName });
      }
      // For other roles (button/link/textbox/...) keep AX as-is — already interactive.
    } else {
      // Inject branch — Task 15 will fill this in
    }
  }

  const finalNodes = base.nodes.map(n => {
    const u = upgraded.get(n.uid);
    return u ? { ...n, upgrade: u } : n;
  }).concat(injected);

  // Suppress unused-variable warnings for variables reserved for Task 15.
  void nextUid;
  void finalUidToBackendNodeId;

  return {
    nodes: finalNodes,
    uidToBackendNodeId: finalUidToBackendNodeId,
    axIdToUid: base.axIdToUid,
    axNodeByBackendId: base.axNodeByBackendId,
    backendIdToUid: base.backendIdToUid,
  };
}
