import type { Snapshot, SnapshotNode } from '../types.js';
import type { MergedNode } from './types.js';

/**
 * Build the final Snapshot from merged nodes.
 * Extracts AX properties, resolves children, sets frameUrl.
 */
export function buildSnapshotOutput(
  nodes: MergedNode[],
  axIdToUid: Map<string, string>,
): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();

  for (const merged of nodes) {
    const { axNode } = merged;

    const snapshotNode: SnapshotNode = {
      uid: merged.uid,
      role: axNode.role?.value ?? '',
      name: axNode.name?.value ?? '',
    };

    // frameUrl (only for iframe nodes)
    if (merged.frameUrl != null) {
      snapshotNode.frameUrl = merged.frameUrl;
    }

    // Optional AX properties
    if (axNode.properties) {
      for (const prop of axNode.properties) {
        const val = prop.value?.value;
        switch (prop.name) {
          case 'focused':
            if (val) snapshotNode.focused = true;
            break;
          case 'disabled':
            if (val) snapshotNode.disabled = true;
            break;
          case 'expanded':
            if (val != null) snapshotNode.expanded = val;
            break;
          case 'selected':
            if (val) snapshotNode.selected = true;
            break;
          case 'level':
            if (val != null) snapshotNode.level = val;
            break;
        }
      }
    }

    // Value (form elements)
    if (axNode.value?.value != null) {
      snapshotNode.value = String(axNode.value.value);
    }

    // Children (resolve AX childIds to assigned uids, scoped by frameId)
    if (axNode.childIds?.length) {
      const childUids: string[] = [];
      for (const childId of axNode.childIds) {
        const childUid = axIdToUid.get(`${merged.frameId}:${childId}`);
        if (childUid) childUids.push(childUid);
      }
      if (childUids.length > 0) {
        snapshotNode.children = childUids;
      }
    }

    idToNode.set(merged.uid, snapshotNode);
  }

  return { idToNode };
}
