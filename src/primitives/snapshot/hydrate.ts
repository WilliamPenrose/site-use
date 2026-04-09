import type { RawFrameAX } from './types.js';

/**
 * Hydrate raw CDP data into usable lookup structures.
 * M1: passthrough — AX data is already in usable format.
 * Future (M2): DOMSnapshot SoA → per-node lookup.
 * Future (M3): DOM tree → backendNodeId lookup.
 */
export function hydrateAXData(rawData: RawFrameAX[]): RawFrameAX[] {
  return rawData;
}
