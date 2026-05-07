/** Raw AX data from a single frame, returned by fetch stage. */
export interface RawFrameAX {
  frameId: string;
  frameUrl: string;
  isMainFrame: boolean;
  nodes: any[]; // CDP Protocol.Accessibility.AXNode[]
}

/** Raw DOMSnapshot data, returned by fetch stage. */
export interface RawDomSnapshot {
  documents: any[]; // CDP DocumentSnapshot[]
  strings: string[];
}

/** Combined raw fetch output. */
export interface RawSnapshotData {
  frames: RawFrameAX[];
  domSnapshot: RawDomSnapshot;
}

/** Per-DOM-node hydrated entry, keyed by backendNodeId. */
export interface DomEntry {
  backendNodeId: number;
  frameId: string;
  parentBackendNodeId: number | null;
  tag: string;                 // lowercase, e.g. 'div', 'button'
  attributes: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number } | null;
  cursorStyle: string | null;
  isClickable: boolean;
  nodeType: number;            // 1=element, 3=text
  nodeValue: string | null;    // text content for text nodes
}

export type DomLookup = Map<number, DomEntry>;

/** Hydrated pipeline data passed to merge. */
export interface HydratedData {
  frames: RawFrameAX[];
  domLookup: DomLookup;
  /** frameId -> frameUrl, populated from RawFrameAX */
  frameUrlByFrameId: Map<string, string>;
  /** Main frameId, used to decide frameUrl=undefined for main frame. */
  mainFrameId: string;
}

/** Node after merge stage — ready for filtering and output. */
export interface MergedNode {
  uid: string;
  axNode: any | null;          // null for inferred-injected nodes
  backendNodeId: number | null;
  frameId: string;
  frameUrl: string | undefined; // undefined for main frame
  /** Set when an existing AX node's role/name is rewritten by ClickableElementDetector. */
  upgrade?: { role: string; name: string };
  /** Set when a node is created from DOM data alone (no corresponding AX node). */
  inferred?: { role: string; name: string };
}

/** Limits for iframe traversal to defend against malicious pages. */
export const MAX_IFRAME_DEPTH = 5;
export const MAX_IFRAMES = 100;

export interface MergeResult {
  nodes: MergedNode[];
  uidToBackendNodeId: Map<string, number>;
  axIdToUid: Map<string, string>;
  /** backendNodeId -> AX node, populated for nodes that survived shouldSkipNode and have backendDOMNodeId. */
  axNodeByBackendId: Map<number, any>;
  /** backendNodeId -> uid, reverse of uidToBackendNodeId (built once for M2 join). */
  backendIdToUid: Map<number, string>;
}
