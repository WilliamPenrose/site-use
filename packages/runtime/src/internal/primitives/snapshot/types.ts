/** Raw AX data from a single frame, returned by fetch stage. */
export interface RawFrameAX {
  frameId: string;
  frameUrl: string;
  isMainFrame: boolean;
  nodes: any[]; // CDP Protocol.Accessibility.AXNode[]
}

/** Node after merge stage — ready for filtering and output. */
export interface MergedNode {
  uid: string;
  axNode: any; // Original CDP AXNode
  backendNodeId: number | null;
  frameId: string; // frame that owns this node (for scoped child lookup)
  frameUrl: string | undefined; // undefined for main frame
}

/** Limits for iframe traversal to defend against malicious pages. */
export const MAX_IFRAME_DEPTH = 5;
export const MAX_IFRAMES = 100;
