import type { MergedNode } from './types.js';

/**
 * Filter merged nodes.
 * M1: passthrough — no additional filtering beyond shouldSkipNode in merge.
 * Future (M2): ClickableElementDetector
 * Future (M4): PaintOrderRemover, bbox filter, simplify, optimize
 */
export function filterNodes(nodes: MergedNode[]): MergedNode[] {
  return nodes;
}
